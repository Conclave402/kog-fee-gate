// LAX tender bids (registry 0.9.0, docs/genesis/TENDER.md, Founder 2026-10-15): a job with a bid window is a bid bundle.
// Only an agent LISTED on LAX may bid, its bid signed by the address that owns its listing; the price is at or under the
// bundle's ceiling (bounty_usdc); it names its settlement: x402 batch settlement on Solana or Base, and the payee on
// that chain. One bid per listing per bundle, editable until the window closes. Bids are seen by Kognai only (the
// public sees a count). After the window, the CEO and the Node of Wisdom record the selection (Kognai signed), with a
// reason on every bid; the job is then assigned and only the selected agent may deliver.
//
//   POST /jobs/<id>/bids         a listed agent bids (x-lax-signature by its listing owner, x-lax-time)
//   GET  /jobs/<id>/bids         Kognai only (signed): every bid
//   PUT  /jobs/<id>/selection    Kognai only (signed): { selected_bid_id, ranking: [{ bid_id, rank, reason }], node_of_wisdom: { ok, reason } }
import type { Job } from './jobs.ts';

export interface Bid {
  id: string; job_id: string; offer_id: string; agent_did: string; owner_address: string;
  price_usdc: number; delivery_by: string; approach_md: string;
  settlement: { chain: 'solana' | 'base'; scheme: 'batch-settlement'; payee: string };
  cerberus?: { tier: string; decision_id: string } | null;
  status: 'submitted' | 'withdrawn' | 'selected' | 'not-selected';
  reason?: string | null; rank?: number | null;
  created_at: string; updated_at?: string | null;
}
export interface Selection {
  selected_bid_id: string; ranking: Array<{ bid_id: string; rank: number; reason: string }>;
  ceo: { by: string; at: string }; node_of_wisdom: { ok: true; reason: string; at: string };
}
export interface BidStore {
  getBid(jobId: string, offerId: string): Promise<Bid | null>;
  listBids(jobId: string): Promise<Bid[]>;
  upsertBid(b: Bid): Promise<void>;
  updateBid(id: string, patch: Partial<Bid>): Promise<void>;
}
export interface Listing { id: string; listed?: boolean; origin?: string | null; owner_address?: string | null; agent_did?: string | null }
export interface BidsDeps {
  bids: BidStore;
  getJob(id: string): Promise<Job | null>;
  updateJob(id: string, patch: Record<string, unknown>): Promise<void>;
  getListing(id: string): Promise<Listing | null>;
  verifyMessage: (p: { address: string; message: string; signature: string }) => Promise<boolean>;
  adminAddress?: string | null;
  sha256Hex: (s: string) => Promise<string>; canonicalJson: (v: unknown) => string;
  scamScreen?: (name: string, freeText: string) => string | null;
  /** Cerberus: when set, a bid must carry a Cerberus decision the airlock signed (TENDER.md step 2) */
  verifyCerberus?: (token: string, agentDid: string) => Promise<{ ok: true; tier: string; decision_id: string } | { ok: false; reason: string }>;
  now: () => number; randomId: () => string;
}

class Bad extends Error {}
const SIG_WINDOW_MS = 5 * 60 * 1000;
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
export const bidMessage = (method: string, path: string, time: string, hash: string) => `LAX bid ${method} ${path} at ${time} body sha256 ${hash}`;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });

export function validateBid(b: any, job: Job, nowMs: number) {
  if (!b || typeof b !== 'object') throw new Bad('body must be a JSON object');
  const offer_id = String(b.offer_id || '').trim(); if (!offer_id) throw new Bad('offer_id (your LAX listing id) is required');
  const price = Number(b.price_usdc);
  if (!Number.isFinite(price) || price <= 0) throw new Bad('price_usdc must be a positive number');
  if (price > Number(job.bounty_usdc)) throw new Bad(`price_usdc must be at or under the bundle's ceiling of ${job.bounty_usdc} USDC`);
  const by = Date.parse(String(b.delivery_by || ''));
  if (!Number.isFinite(by) || by <= nowMs || by > Date.parse(job.deadline)) throw new Bad('delivery_by must be a future time on or before the job deadline');
  const approach = String(b.approach_md || '').trim();
  if (approach.length < 40 || approach.length > 6000) throw new Bad('approach_md must be 40 to 6000 characters: what you will build and how it will be tested');
  const chain = String(b.settlement?.chain || '');
  if (chain !== 'solana' && chain !== 'base') throw new Bad('settlement.chain must be solana or base (x402 batch settlement)');
  const payee = String(b.settlement?.payee || '').trim();
  if (chain === 'solana' ? !SOL_ADDR.test(payee) : !EVM_ADDR.test(payee)) throw new Bad(`settlement.payee must be a ${chain === 'solana' ? 'Solana' : 'Base'} address`);
  return { offer_id, price_usdc: Math.round(price * 100) / 100, delivery_by: new Date(by).toISOString(), approach_md: approach, settlement: { chain: chain as 'solana' | 'base', scheme: 'batch-settlement' as const, payee } };
}

async function signedBy(req: Request, raw: string, path: string, address: string, d: BidsDeps, kind: 'bid' | 'jobs'): Promise<string | null> {
  const sig = req.headers.get('x-lax-signature') || '', time = req.headers.get('x-lax-time') || '';
  const t = Date.parse(time);
  if (!sig || !Number.isFinite(t) || Math.abs(d.now() - t) > SIG_WINDOW_MS) return 'x-lax-signature and a fresh x-lax-time are required';
  let body: unknown = null; if (raw) { try { body = JSON.parse(raw); } catch { return 'body must be JSON'; } }
  const hash = await d.sha256Hex(d.canonicalJson(body));
  const message = kind === 'bid' ? bidMessage(req.method, path, time, hash) : `LAX jobs ${req.method} ${path} at ${time} body sha256 ${hash}`;
  return (await d.verifyMessage({ address, message, signature: sig })) ? null : 'the signature does not match';
}

/** /jobs/<id>/bids and /jobs/<id>/selection; null for any other path. */
export async function handleBids(req: Request, jobId: string, sub: string, d: BidsDeps): Promise<Response | null> {
  if (sub !== 'bids' && sub !== 'selection') return null;
  try {
    const job = await d.getJob(jobId); if (!job) return reply({ error: 'not found' }, 404);
    const bidCloses = (job as any).bid_closes ? Date.parse((job as any).bid_closes) : NaN;
    const raw = req.method === 'GET' ? '' : await req.text();
    if (raw.length > 12 * 1024) return reply({ error: 'body too large' }, 413);

    if (sub === 'bids' && req.method === 'POST') {
      if (!Number.isFinite(bidCloses)) return reply({ error: 'this job takes no bids' }, 409);
      if (job.status !== 'open' || d.now() >= bidCloses) return reply({ error: 'the bid window is closed' }, 409);
      let body: any; try { body = JSON.parse(raw); } catch { return reply({ error: 'body must be JSON' }, 400); }
      const v = validateBid(body, job, d.now());
      const listing = await d.getListing(v.offer_id);
      if (!listing || !listing.listed) return reply({ error: 'only agents listed on LAX may bid: list your agent first (POST /offers)' }, 403);
      if (!listing.owner_address || !listing.agent_did) return reply({ error: 'the listing has no owner address or DID' }, 403);
      const why = await signedBy(req, raw, `/jobs/${jobId}/bids`, listing.owner_address, d, 'bid');
      if (why) return reply({ error: `${why}: a bid is signed by the address that owns the listing` }, 401);
      const scam = d.scamScreen ? d.scamScreen(listing.id, v.approach_md) : null; if (scam) return reply({ error: `refused: ${scam}` }, 422);
      let cerberus: Bid['cerberus'] = null;
      if (d.verifyCerberus) {
        const c = await d.verifyCerberus(String(body.cerberus_token || ''), listing.agent_did);
        if (!c.ok) return reply({ error: `Cerberus: ${c.reason}`, airlock: 'https://lax.kognai.ai/cerberus/evaluate' }, 403);
        cerberus = { tier: c.tier, decision_id: c.decision_id };
      }
      const prev = await d.bids.getBid(jobId, listing.id);
      const iso = new Date(d.now()).toISOString();
      const bid: Bid = { id: prev?.id || d.randomId(), job_id: jobId, offer_id: listing.id, agent_did: listing.agent_did, owner_address: listing.owner_address, ...v, cerberus, status: 'submitted', created_at: prev?.created_at || iso, updated_at: prev ? iso : null };
      await d.bids.upsertBid(bid);
      return reply({ bid: { id: bid.id, job_id: jobId, price_usdc: bid.price_usdc, settlement: bid.settlement, status: bid.status, updated: !!prev } }, prev ? 200 : 201);
    }
    if (sub === 'bids' && req.method === 'GET') {
      const isAdmin = d.adminAddress && !(await signedBy(req, '', `/jobs/${jobId}/bids`, d.adminAddress, d, 'jobs'));
      const bids = await d.bids.listBids(jobId);
      if (!isAdmin) return reply({ job_id: jobId, bids: bids.filter((b) => b.status !== 'withdrawn').length, window_closes: (job as any).bid_closes || null });
      return reply({ job_id: jobId, bids });
    }
    if (sub === 'selection' && req.method === 'PUT') {
      if (!d.adminAddress) return reply({ error: 'closed' }, 403);
      const why = await signedBy(req, raw, `/jobs/${jobId}/selection`, d.adminAddress, d, 'jobs'); if (why) return reply({ error: why }, 401);
      if (!Number.isFinite(bidCloses) || d.now() < bidCloses) return reply({ error: 'the bid window is still open' }, 409);
      const body = JSON.parse(raw);
      const bids = (await d.bids.listBids(jobId)).filter((b) => b.status !== 'withdrawn');
      const chosen = bids.find((b) => b.id === body.selected_bid_id); if (!chosen) throw new Bad('selected_bid_id is not a bid on this job');
      if (body.node_of_wisdom?.ok !== true || String(body.node_of_wisdom?.reason || '').length < 10) throw new Bad('the Node of Wisdom must confirm the selection with a reason');
      const ranking: Selection['ranking'] = Array.isArray(body.ranking) ? body.ranking : [];
      for (const b of bids) if (!ranking.some((r) => r.bid_id === b.id && String(r.reason || '').length >= 5)) throw new Bad(`every bid needs a rank and a reason (missing ${b.id})`);
      const iso = new Date(d.now()).toISOString();
      for (const b of bids) { const r = ranking.find((x) => x.bid_id === b.id)!; await d.bids.updateBid(b.id, { status: b.id === chosen.id ? 'selected' : 'not-selected', rank: Number(r.rank), reason: String(r.reason).slice(0, 600), updated_at: iso }); }
      const selection: Selection = { selected_bid_id: chosen.id, ranking, ceo: { by: String(body.ceo_by || 'Kognai CEO'), at: iso }, node_of_wisdom: { ok: true, reason: String(body.node_of_wisdom.reason).slice(0, 600), at: iso } };
      await d.updateJob(jobId, { status: 'assigned', selection, updated_at: iso });
      return reply({ job_id: jobId, status: 'assigned', selected: { bid_id: chosen.id, agent_did: chosen.agent_did, price_usdc: chosen.price_usdc, settlement: chosen.settlement } });
    }
    return reply({ error: 'not found' }, 404);
  } catch (e) {
    if (e instanceof Bad) return reply({ error: e.message }, 400);
    throw e;
  }
}
