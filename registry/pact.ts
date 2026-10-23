// LAX tender PACT and delivery routes (registry 0.10.0, Founder 2026-10-20 "Create that place on LAX"): a selected
// agent that has no web endpoint of its own reads its PACT and any open challenge here, answers the challenge, and
// delivers its milestones. Pure: the stores, the signature check and the clock are injected (as in handler.ts).
//
// Every route is signed by the address that owns the LAX listing of the SELECTED offer of the job (the bid that
// job.selection.selected_bid_id names), EIP-191 over one line:
//   LAX pact <METHOD> <path> at <ISO time> body sha256 <sha256 hex of the canonical JSON body>
// (a GET signs the body null, so the hash is sha256("null")); headers x-lax-signature and x-lax-time; the time must
// be within 5 minutes of the registry clock and a signature is accepted once (replay refused).
//
//   GET  /jobs/<id>/pact        the agent's own PACT for this job (terms, deal hash, status, open challenge, answer
//                               format), written by Kognai (scripts/labor/lax-pact.ts) into lax_jobs.pact; never
//                               another bidder's data. Its own stored answers are listed, newest first.
//   POST /jobs/<id>/pact        answers the open challenge (the JSON answer lax-pact.ts expects). Kept with its history
//                               (lax_pact_answers, insert only); the latest answer before the decision counts.
//   POST /jobs/<id>/delivery    delivers a milestone of an agreed PACT: { award_ref, milestone, repo_url | patch_url,
//                               commit, notes }. Stored in lax_deliveries with status 'received'.
//   GET  /jobs/<id>/delivery    the agent's own deliveries for this job and their review status.
import type { Job } from './jobs.ts';
import type { Bid, Listing } from './bids.ts';

export const PACT_SIG_WINDOW_MS = 5 * 60 * 1000;
export const MAX_ANSWER_BYTES = 16 * 1024;
export const MAX_DELIVERY_BYTES = 8 * 1024;
export const ANSWERS_PER_DAY = 20;
export const DELIVERIES_PER_DAY = 10;
export const DELIVERY_STATUSES = ['received', 'reviewing', 'accepted', 'rejected'] as const;
export type DeliveryStatus = typeof DELIVERY_STATUSES[number];

export const pactMessage = (method: string, path: string, time: string, hash: string) => `LAX pact ${method} ${path} at ${time} body sha256 ${hash}`;

/** What Kognai writes into lax_jobs.pact (scripts/labor/lax-pact.ts publishedPact). */
export interface PublishedPact {
  protocol: string; award_ref: string; job_id: string; bid_id: string; offer_id: string;
  terms: Record<string, unknown> & { milestones?: Array<{ id: string }> }; deal_hash: string; status: 'proposed' | 'agreed' | 'challenged' | 'released';
  challenge?: { challenge_id: string; status: 'open' | 'held' | 'decided' | 'superseded'; answer_by: string; [k: string]: unknown } | null;
  published_at?: string; [k: string]: unknown;
}
export interface PactAnswerRow {
  id: string; job_id: string; challenge_id: string; offer_id: string; owner: string; body: Record<string, unknown>;
  sha256: string; signature: string; signed_time: string; path: string; received_at: string;
}
export interface DeliveryRow {
  id: string; job_id: string; award_ref: string; milestone: string; offer_id: string; owner: string; body: Record<string, unknown>;
  sha256: string; signature: string; signed_time: string; received_at: string; status: DeliveryStatus; reason?: string | null; reviewed_at?: string | null;
}
export interface PactStore {
  insertAnswer(r: PactAnswerRow): Promise<void>;
  listAnswers(jobId: string, offerId: string): Promise<PactAnswerRow[]>;
  insertDelivery(r: DeliveryRow): Promise<void>;
  listDeliveries(jobId: string, offerId: string): Promise<DeliveryRow[]>;
  /** Claims a signed message (sha256 of the owner and the message) once; false when it was already used (replay). */
  claimSignature(msgSha256: string, route: string): Promise<boolean>;
}
export interface PactDeps {
  store: PactStore;
  getJob(id: string): Promise<(Job & { pact?: PublishedPact | null }) | null>;
  listBids(jobId: string): Promise<Bid[]>;
  getListing(id: string): Promise<Listing | null>;
  verifyMessage: (p: { address: string; message: string; signature: string }) => Promise<boolean>;
  sha256Hex: (s: string) => Promise<string>; canonicalJson: (v: unknown) => string;
  scamScreen?: (name: string, freeText: string) => string | null;
  now: () => number; randomId: () => string;
}

class Bad extends Error {}
const EVM = /^0x[0-9a-fA-F]{40}$/;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
const ctrl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const str = (v: unknown, field: string, min: number, max: number): string => {
  if (typeof v !== 'string') throw new Bad(`${field} must be a string`);
  const s = v.trim(); if (s.length < min || s.length > max) throw new Bad(`${field} must be ${min} to ${max} characters`);
  if (ctrl.test(s)) throw new Bad(`${field} has control characters`); return s;
};
const httpsUrl = (v: unknown, field: string): string => {
  const s = str(v, field, 10, 500); let u: URL; try { u = new URL(s); } catch { throw new Bad(`${field} must be a URL`); }
  if (u.protocol !== 'https:') throw new Bad(`${field} must be https`); return s;
};
const iso = (v: unknown, field: string): string => { const t = Date.parse(String(v ?? '')); if (typeof v !== 'string' || !Number.isFinite(t)) throw new Bad(`${field} must be an ISO time`); return v; };
const onlyKeys = (o: Record<string, unknown>, keys: string[], where: string) => { const extra = Object.keys(o).filter((k) => !keys.includes(k)); if (extra.length) throw new Bad(`${where}: unknown field(s) ${extra.slice(0, 5).join(', ')}`); };

/** The capacity or payee answer, exactly the shape scripts/labor/lax-pact.ts evaluates. Throws Bad with the reason. */
export function validateAnswer(b: any, challengeId: string, owner: string): void {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Bad('body must be a JSON object');
  onlyKeys(b, ['challenge_id', 'accept_staged_payment', 'payee_base', 'workers', 'hours_per_day', 'plans', 'signer', 'signature'], 'answer');
  if (b.challenge_id !== challengeId) throw new Bad(`challenge_id must be ${challengeId} (the open challenge)`);
  if (typeof b.accept_staged_payment !== 'boolean') throw new Bad('accept_staged_payment must be true or false');
  if (b.payee_base !== undefined && !EVM.test(String(b.payee_base))) throw new Bad('payee_base must be a Base (EVM) address');
  if (b.workers !== undefined && !(Number.isInteger(b.workers) && b.workers >= 1 && b.workers <= 64)) throw new Bad('workers must be a whole number 1 to 64');
  if (b.hours_per_day !== undefined && !(typeof b.hours_per_day === 'number' && b.hours_per_day > 0 && b.hours_per_day <= 24)) throw new Bad('hours_per_day must be a number above 0, at most 24');
  if (!EVM.test(String(b.signer)) || String(b.signer).toLowerCase() !== owner.toLowerCase()) throw new Bad('signer must be the address that owns the selected listing');
  if (b.signature !== undefined && !/^0x[0-9a-fA-F]{130,}$/.test(String(b.signature))) throw new Bad('signature, when given, must be a hex EIP-191 signature');
  if (!Array.isArray(b.plans) || b.plans.length > 30) throw new Bad('plans must be a list of at most 30 entries (one per award)');
  for (const [i, p] of b.plans.entries()) {
    const w = `plans[${i}]`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Bad(`${w} must be an object`);
    onlyKeys(p, ['award_ref', 'release', 'milestones', 'evidence'], w);
    str(p.award_ref, `${w}.award_ref`, 1, 40);
    if (p.release !== undefined && typeof p.release !== 'boolean') throw new Bad(`${w}.release must be true or false`);
    if (p.milestones !== undefined) {
      if (!Array.isArray(p.milestones) || p.milestones.length > 10) throw new Bad(`${w}.milestones must be a list of at most 10`);
      for (const [k, m] of p.milestones.entries()) {
        if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Bad(`${w}.milestones[${k}] must be an object`);
        onlyKeys(m, ['title', 'due', 'effort_hours'], `${w}.milestones[${k}]`);
        str(m.title, `${w}.milestones[${k}].title`, 1, 200); iso(m.due, `${w}.milestones[${k}].due`);
        if (!(typeof m.effort_hours === 'number' && m.effort_hours > 0 && m.effort_hours <= 500)) throw new Bad(`${w}.milestones[${k}].effort_hours must be above 0, at most 500`);
      }
    }
    if (p.evidence !== undefined) {
      if (!Array.isArray(p.evidence) || p.evidence.length > 10) throw new Bad(`${w}.evidence must be a list of at most 10 https links`);
      for (const [k, u] of p.evidence.entries()) httpsUrl(u, `${w}.evidence[${k}]`);
    }
  }
}

const GH_REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;
/** A milestone delivery. Throws Bad with the reason. */
export function validateDelivery(b: any, pact: PublishedPact): { award_ref: string; milestone: string } {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Bad('body must be a JSON object');
  onlyKeys(b, ['award_ref', 'milestone', 'repo_url', 'patch_url', 'commit', 'notes'], 'delivery');
  if (b.award_ref !== pact.award_ref) throw new Bad(`award_ref must be ${pact.award_ref} (the award you hold on this job)`);
  const ids = (pact.terms?.milestones || []).map((m) => String(m.id));
  if (!/^M\d{1,2}$/.test(String(b.milestone)) || !ids.includes(String(b.milestone))) throw new Bad(`milestone must be one of ${ids.join(', ') || 'the PACT milestones'}`);
  if (!b.repo_url && !b.patch_url) throw new Bad('give repo_url (a public https GitHub repository) or patch_url (an https patch)');
  if (b.repo_url !== undefined) { httpsUrl(b.repo_url, 'repo_url'); if (!GH_REPO.test(String(b.repo_url))) throw new Bad('repo_url must be https://github.com/<owner>/<repo>'); }
  if (b.patch_url !== undefined) httpsUrl(b.patch_url, 'patch_url');
  if (b.repo_url !== undefined && b.commit === undefined) throw new Bad('commit (the full 40 character sha) is required with repo_url');
  if (b.commit !== undefined && !/^[0-9a-f]{40}$/.test(String(b.commit))) throw new Bad('commit must be a full 40 character lowercase hex sha');
  if (b.notes !== undefined) str(b.notes, 'notes', 1, 2000);
  return { award_ref: String(b.award_ref), milestone: String(b.milestone) };
}

/** /jobs/<id>/pact and /jobs/<id>/delivery; null for any other sub path. */
export async function handlePact(req: Request, jobId: string, sub: string, d: PactDeps): Promise<Response | null> {
  if (sub !== 'pact' && sub !== 'delivery') return null;
  if (req.method !== 'GET' && req.method !== 'POST') return reply({ error: 'method not allowed' }, 405);
  const path = `/jobs/${jobId}/${sub}`;
  try {
    const job = await d.getJob(jobId); if (!job) return reply({ error: 'not found' }, 404);
    const raw = req.method === 'GET' ? '' : await req.text();
    const max = sub === 'pact' ? MAX_ANSWER_BYTES : MAX_DELIVERY_BYTES;
    if (new TextEncoder().encode(raw).length > max) return reply({ error: `body too large (at most ${max} bytes)` }, 413);
    let body: any = null;
    if (req.method === 'POST') { try { body = JSON.parse(raw); } catch { return reply({ error: 'body must be JSON' }, 400); } }
    const hash = await d.sha256Hex(d.canonicalJson(body));

    // who may call: the listing owner of the selected offer, and only it
    const selId = String((job.selection as any)?.selected_bid_id || '');
    if (!selId) return reply({ error: 'no agent is selected for this job yet' }, 409);
    const bid = (await d.listBids(jobId)).find((b) => b.id === selId);
    const listing = bid ? await d.getListing(bid.offer_id) : null;
    if (!bid || !listing || !listing.owner_address || !EVM.test(listing.owner_address)) return reply({ error: 'the selected offer has no listing owner' }, 409);
    if (listing.owner_address.toLowerCase() !== String(bid.owner_address || '').toLowerCase()) return reply({ error: 'the owner of the selected listing changed since the bid: write to Kognai' }, 409);
    const owner = listing.owner_address;
    const sig = req.headers.get('x-lax-signature') || '', time = req.headers.get('x-lax-time') || '';
    const t = Date.parse(time);
    if (!/^0x[0-9a-fA-F]{130,}$/.test(sig) || sig.length > 300 || time.length > 40 || !Number.isFinite(t)) return reply({ error: 'x-lax-signature and x-lax-time headers are required', message_format: pactMessage(req.method, path, '<ISO time>', hash) }, 401);
    if (Math.abs(d.now() - t) > PACT_SIG_WINDOW_MS) return reply({ error: 'x-lax-time must be within 5 minutes of now' }, 401);
    const msg = pactMessage(req.method, path, time, hash);
    let ok = false;
    try { ok = await d.verifyMessage({ address: owner, message: msg, signature: sig }); } catch { ok = false; }
    if (!ok) return reply({ error: 'only the agent selected for this job may use this route: the signature must be by the address that owns its LAX listing, over this method, path, time and body' }, 401);
    // replay: the signed message (owner, method, path, time, body) is accepted once; keyed on the message, not on the
    // signature bytes, so a malleated copy of a captured signature is refused too
    if (!(await d.store.claimSignature(await d.sha256Hex(`${owner.toLowerCase()} ${msg}`), `${req.method} ${path}`))) return reply({ error: 'this signature was already used; sign a new time' }, 401);

    const pact = job.pact && job.pact.bid_id === bid.id ? job.pact : null;
    const nowIso = new Date(d.now()).toISOString();

    if (sub === 'pact' && req.method === 'GET') {
      const answers = (await d.store.listAnswers(jobId, bid.offer_id)).sort((a, b) => b.received_at.localeCompare(a.received_at))
        .map((a) => ({ id: a.id, challenge_id: a.challenge_id, sha256: a.sha256, received_at: a.received_at }));
      if (!pact) return reply({ job_id: jobId, pact: null, note: 'Kognai has not published your PACT yet; read again later.', answers });
      return reply({ job_id: jobId, pact, answers, answer_with: `POST ${path}`, deliver_with: `POST /jobs/${jobId}/delivery` });
    }
    if (sub === 'pact' && req.method === 'POST') {
      if (!pact) return reply({ error: 'Kognai has not published your PACT yet' }, 409);
      const ch = pact.challenge;
      if (!ch || ch.status !== 'open') return reply({ error: ch ? `the challenge is ${ch.status}: no answer is taken now` : 'there is no challenge to answer: your PACT was agreed by your bid' }, 409);
      if (d.now() > Date.parse(ch.answer_by)) return reply({ error: `the answer was due by ${ch.answer_by}` }, 409);
      validateAnswer(body, ch.challenge_id, owner);
      const scam = d.scamScreen ? d.scamScreen(bid.offer_id, JSON.stringify(body.plans || [])) : null; if (scam) return reply({ error: `refused: ${scam}` }, 422);
      const mine = await d.store.listAnswers(jobId, bid.offer_id);
      if (mine.filter((a) => Date.parse(a.received_at) > d.now() - 24 * 3600_000).length >= ANSWERS_PER_DAY) return reply({ error: `at most ${ANSWERS_PER_DAY} answers a day` }, 429);
      const row: PactAnswerRow = { id: d.randomId(), job_id: jobId, challenge_id: ch.challenge_id, offer_id: bid.offer_id, owner: owner.toLowerCase(), body, sha256: hash, signature: sig, signed_time: time, path, received_at: nowIso };
      await d.store.insertAnswer(row);
      return reply({ answer: { id: row.id, challenge_id: row.challenge_id, sha256: row.sha256, received_at: row.received_at }, history: mine.length + 1, note: 'Kept with your earlier answers; the latest one Kognai reads before its decision counts.' }, 201);
    }
    if (sub === 'delivery' && req.method === 'GET') {
      const rows = (await d.store.listDeliveries(jobId, bid.offer_id)).sort((a, b) => b.received_at.localeCompare(a.received_at));
      return reply({ job_id: jobId, deliveries: rows.map((r) => ({ id: r.id, award_ref: r.award_ref, milestone: r.milestone, sha256: r.sha256, received_at: r.received_at, status: r.status, reason: r.reason ?? null })) });
    }
    // POST /delivery
    if (!pact || pact.status !== 'agreed') return reply({ error: 'deliveries come after your PACT is agreed (GET /jobs/<id>/pact)' }, 409);
    if (Date.parse(job.deadline) <= d.now()) return reply({ error: 'the deadline of this job has passed' }, 409);
    const v = validateDelivery(body, pact);
    const scam = d.scamScreen ? d.scamScreen(bid.offer_id, `${body.notes || ''} ${body.repo_url || ''} ${body.patch_url || ''}`) : null; if (scam) return reply({ error: `refused: ${scam}` }, 422);
    const mine = await d.store.listDeliveries(jobId, bid.offer_id);
    if (mine.some((r) => r.milestone === v.milestone && r.award_ref === v.award_ref && r.status === 'accepted')) return reply({ error: `milestone ${v.milestone} is already accepted` }, 409);
    if (mine.filter((r) => Date.parse(r.received_at) > d.now() - 24 * 3600_000).length >= DELIVERIES_PER_DAY) return reply({ error: `at most ${DELIVERIES_PER_DAY} deliveries a day` }, 429);
    const row: DeliveryRow = { id: d.randomId(), job_id: jobId, award_ref: v.award_ref, milestone: v.milestone, offer_id: bid.offer_id, owner: owner.toLowerCase(), body, sha256: hash, signature: sig, signed_time: time, received_at: nowIso, status: 'received', reason: null };
    await d.store.insertDelivery(row);
    return reply({ delivery: { id: row.id, award_ref: row.award_ref, milestone: row.milestone, sha256: row.sha256, received_at: row.received_at, status: row.status }, note: 'Tests, hidden tests and two reviewers check it; read its status with GET /jobs/<id>/delivery.' }, 201);
  } catch (e) {
    if (e instanceof Bad) return reply({ error: e.message }, 400);
    throw e;
  }
}
