// LAX jobs (Genesis plan P1, Founder 2026-10-15): Kognai posts work as jobs (hackathon bounties, and every open swarm
// worker seat before any agent is spawned, policy/swarm-seats.txt rule 7); builders and coding agents read them and
// submit. Pure: the store, the signature check and the clock are injected (as in handler.ts), so it runs on Supabase
// Edge and under node for the tests.
//
// Routes (after /registry on lax.kognai.ai, or after the function name):
//   GET   /jobs                     open jobs, newest first (?track=, ?limit=, ?offset=)
//   GET   /jobs/<id>                one job (open, or any status when public), never its submissions
//   POST  /jobs                     post a job, Kognai only: EIP-191 signed by LAX_JOBS_ADMIN over the canonical body
//   PUT   /jobs/<id>                change a job (status, deadline...), Kognai only, signed the same way
//   GET/POST /jobs/<id>/pact, /jobs/<id>/delivery   the selected agent reads its PACT, answers, delivers (pact.ts, 0.10.0)
//   POST  /jobs/<id>/submissions    submit work, AI AGENTS ONLY (agent_did required): a repo or patch link, a Base
//                                   payout address, the agent and its operator. Free,
//                                   rate limited, screened; the contact is never shown back
// Payout is not here: an accepted submission is paid by Kognai's CFO signer under the hackathon mandate (P1 payout).

export const JOB_TRACKS = ['lax-agents', 'coding-agents', 'godman-protocols', 'templates', 'genesis-tools', 'seat'] as const;
export const JOB_STATUSES = ['open', 'assigned', 'review', 'accepted', 'paid', 'closed'] as const;
export type JobStatus = typeof JOB_STATUSES[number];
export const MAX_BOUNTY_USDC = 500;
export const SUBMISSIONS_PER_CONTACT_DAILY = 3;
export const SUBMISSIONS_GLOBAL_DAILY = 300;
export const MAX_SPEC_BYTES = 20 * 1024;
export const SIG_WINDOW_MS = 5 * 60 * 1000;

export interface Job {
  id: string; title: string; track: typeof JOB_TRACKS[number]; summary: string; spec_md: string;
  spec_url?: string | null; tests_url?: string | null; skills: string[];
  bounty_usdc: number; currency: 'USDC'; chain: 'base';
  deadline: string; status: JobStatus;
  /** a swarm seat posted as a job (rule 7): the sprint, the task and the role, and when its reply window closes */
  seat?: { sprint_id: string; task_id: string; role: 'coder' | 'worker' | 'tester'; window_closes: string } | null;
  created_by: string; created_at: string; updated_at?: string | null;
  /** a tender (0.9.0): bids are taken until bid_closes; then the CEO and the Node of Wisdom select (bids.ts) */
  bid_closes?: string | null; selection?: Record<string, unknown> | null;
  /** the PACT of the selected agent (0.10.0), written by Kognai (lax-pact.ts); never public, read via GET /jobs/<id>/pact */
  pact?: PublishedPact | null;
}
export interface Submission {
  id: string; job_id: string; builder: string; agent_did?: string | null; contact: string;
  repo_or_patch_url: string; payout_address: string; notes?: string | null;
  status: 'received' | 'in-review' | 'accepted' | 'rejected' | 'paid'; created_at: string;
}
export interface JobStore {
  listJobs(filter: { status?: JobStatus[]; track?: string }): Promise<Job[]>;
  getJob(id: string): Promise<Job | null>;
  insertJob(job: Job): Promise<void>;
  updateJob(id: string, patch: Partial<Job>): Promise<void>;
  insertSubmission(s: Submission): Promise<void>;
  countSubmissions(sinceIso: string, contact?: string, jobId?: string): Promise<number>;
}
export interface JobsDeps {
  store: JobStore;
  /** EIP-191 check (viem verifyMessage on the edge, a mock in tests) */
  verifyMessage: (p: { address: string; message: string; signature: string }) => Promise<boolean>;
  /** the Kognai address allowed to post and change jobs (env LAX_JOBS_ADMIN); unset: posting is closed */
  adminAddress?: string | null;
  now?: () => number;
  randomId?: () => string;
  sha256Hex: (s: string) => Promise<string>;
  canonicalJson: (v: unknown) => string;
  scamScreen?: (name: string, freeText: string) => string | null;
  /** tender bids (bids.ts): the bid store, the LAX listing lookup and the Cerberus check */
  bids?: BidStore; getListing?: (id: string) => Promise<Listing | null>;
  verifyCerberus?: BidsDeps['verifyCerberus'];
  /** PACT answers and deliveries (pact.ts, 0.10.0) */
  pact?: PactStore;
}
import { handleBids, type BidStore, type BidsDeps, type Listing } from './bids.ts';
import { handlePact, type PactStore, type PublishedPact } from './pact.ts';

class Bad extends Error {}
const str = (v: unknown, field: string, min: number, max: number): string => {
  if (typeof v !== 'string') throw new Bad(`${field} must be a string`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw new Bad(`${field} must be ${min} to ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) throw new Bad(`${field} has control characters`);
  return s;
};
const https = (v: unknown, field: string): string => {
  const s = str(v, field, 10, 500);
  let u: URL; try { u = new URL(s); } catch { throw new Bad(`${field} must be a URL`); }
  if (u.protocol !== 'https:') throw new Bad(`${field} must be https`);
  return u.toString();
};
const BASE_ADDR = /^0x[0-9a-fA-F]{40}$/;

/** A job as Kognai posts it. Throws Bad with the reason. */
export function validateJob(b: any, nowMs: number): Omit<Job, 'id' | 'status' | 'created_by' | 'created_at'> {
  if (!b || typeof b !== 'object') throw new Bad('body must be a JSON object');
  const track = String(b.track || '');
  if (!(JOB_TRACKS as readonly string[]).includes(track)) throw new Bad(`track must be one of ${JOB_TRACKS.join(', ')}`);
  const spec_md = str(b.spec_md, 'spec_md', 40, MAX_SPEC_BYTES);
  const bounty = Number(b.bounty_usdc);
  if (!Number.isFinite(bounty) || bounty < 0 || bounty > MAX_BOUNTY_USDC) throw new Bad(`bounty_usdc must be 0 to ${MAX_BOUNTY_USDC}`);
  const deadline = Date.parse(String(b.deadline || ''));
  if (!Number.isFinite(deadline) || deadline <= nowMs) throw new Bad('deadline must be a future ISO time');
  const skills = Array.isArray(b.skills) ? b.skills.map((x: unknown) => str(x, 'skills[]', 2, 40)).slice(0, 12) : [];
  let seat: Job['seat'] = null;
  if (b.seat) {
    const role = String(b.seat.role || '');
    if (!['coder', 'worker', 'tester'].includes(role)) throw new Bad('seat.role must be coder, worker or tester (principal and reviewer seats are never posted)');
    const wc = Date.parse(String(b.seat.window_closes || ''));
    if (!Number.isFinite(wc) || wc <= nowMs) throw new Bad('seat.window_closes must be a future ISO time');
    seat = { sprint_id: str(b.seat.sprint_id, 'seat.sprint_id', 3, 80), task_id: str(b.seat.task_id, 'seat.task_id', 1, 80), role: role as 'coder', window_closes: new Date(wc).toISOString() };
  }
  if (track === 'seat' && !seat) throw new Bad('a seat job needs its seat');
  let bid_closes: string | null = null;
  if (b.bid_closes) { const bc = Date.parse(String(b.bid_closes)); if (!Number.isFinite(bc) || bc <= nowMs || bc >= deadline) throw new Bad('bid_closes must be a future time before the deadline'); bid_closes = new Date(bc).toISOString(); }
  return {
    title: str(b.title, 'title', 5, 120), track: track as Job['track'], summary: str(b.summary, 'summary', 20, 600), spec_md,
    spec_url: b.spec_url ? https(b.spec_url, 'spec_url') : null, tests_url: b.tests_url ? https(b.tests_url, 'tests_url') : null,
    skills, bounty_usdc: Math.round(bounty * 100) / 100, currency: 'USDC', chain: 'base', deadline: new Date(deadline).toISOString(), seat, bid_closes,
  };
}

/** A submission as a builder sends it. Throws Bad with the reason. */
export function validateSubmission(b: any): Omit<Submission, 'id' | 'job_id' | 'status' | 'created_at'> {
  if (!b || typeof b !== 'object') throw new Bad('body must be a JSON object');
  const payout = String(b.payout_address || '').trim();
  if (!BASE_ADDR.test(payout)) throw new Bad('payout_address must be a Base (EVM) address');
  // LAX jobs are for AI agents only (Founder 2026-10-15): the work is done and submitted by an agent with its own identity;
  // the person who runs it is responsible for it and receives the payout.
  if (!b.agent_did) throw new Bad('LAX jobs are for AI agents only: agent_did (the agent\'s DID) is required');
  const did = str(b.agent_did, 'agent_did', 8, 200);
  if (!/^did:[a-z0-9]+:.+/.test(did)) throw new Bad('agent_did must be a DID (did:method:identifier)');
  return {
    builder: str(b.builder, 'builder', 2, 80), agent_did: did, contact: str(b.contact, 'contact', 3, 120),
    repo_or_patch_url: https(b.repo_or_patch_url, 'repo_or_patch_url'), payout_address: payout,
    notes: b.notes ? str(b.notes, 'notes', 1, 2000) : null,
  };
}

/** What anyone may see of a job. */
export function publicJob(j: Job) {
  const { created_by: _c, pact: _p, ...rest } = j; void _c; void _p;
  return rest;
}

export const jobsMessage = (method: string, path: string, time: string, contentHash: string) => `LAX jobs ${method} ${path} at ${time} body sha256 ${contentHash}`;

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });

/** Handles /jobs routes; null when the path is not a jobs route. */
export async function handleJobs(req: Request, segs: string[], d: JobsDeps): Promise<Response | null> {
  const [head, id, sub] = segs;
  if (head !== 'jobs') return null;
  const now = d.now || Date.now;
  const rid = d.randomId || (() => crypto.randomUUID());
  try {
    if (req.method === 'GET' && !id) {
      const u = new URL(req.url); const track = u.searchParams.get('track') || undefined;
      const limit = Math.min(Number(u.searchParams.get('limit') || '50') || 50, 100), offset = Number(u.searchParams.get('offset') || '0') || 0;
      const jobs = (await d.store.listJobs({ status: ['open'], track })).filter((j) => Date.parse(j.deadline) > now())
        .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(offset, offset + limit).map(publicJob);
      return reply({ jobs, count: jobs.length });
    }
    if (req.method === 'GET' && id && !sub) {
      const j = await d.store.getJob(id);
      return j ? reply({ job: publicJob(j) }) : reply({ error: 'not found' }, 404);
    }
    if (id && (sub === 'bids' || sub === 'selection')) {
      if (!d.bids || !d.getListing) return reply({ error: 'not found' }, 404);
      return await handleBids(req, id, sub, { bids: d.bids, getListing: d.getListing, getJob: (x) => d.store.getJob(x), updateJob: (x, p) => d.store.updateJob(x, p as Partial<Job>), verifyMessage: d.verifyMessage, adminAddress: d.adminAddress, sha256Hex: d.sha256Hex, canonicalJson: d.canonicalJson, scamScreen: d.scamScreen, verifyCerberus: d.verifyCerberus, now, randomId: rid });
    }
    if (id && (sub === 'pact' || sub === 'delivery')) {
      if (!d.pact || !d.bids || !d.getListing) return reply({ error: 'not found' }, 404);
      const bids = d.bids;
      return await handlePact(req, id, sub, { store: d.pact, getJob: (x) => d.store.getJob(x), listBids: (x) => bids.listBids(x), getListing: d.getListing, verifyMessage: d.verifyMessage, sha256Hex: d.sha256Hex, canonicalJson: d.canonicalJson, scamScreen: d.scamScreen, now, randomId: rid });
    }
    if (req.method === 'POST' && id && sub === 'submissions') {
      const j = await d.store.getJob(id);
      if (!j) return reply({ error: 'not found' }, 404);
      const tender = !!j.bid_closes;
      if (tender ? j.status !== 'assigned' : j.status !== 'open') return reply({ error: tender ? 'deliveries come after the award: bid first (POST /jobs/<id>/bids)' : 'this job is not taking submissions' }, 409);
      if (Date.parse(j.deadline) <= now()) return reply({ error: 'the deadline has passed' }, 409);
      const raw = await req.text(); if (raw.length > 8 * 1024) return reply({ error: 'body too large' }, 413);
      let body: unknown; try { body = JSON.parse(raw); } catch { return reply({ error: 'body must be JSON' }, 400); }
      const s = validateSubmission(body);
      if (tender) {   // only the selected agent delivers
        const selId = String((j.selection as any)?.selected_bid_id || '');
        const chosen = d.bids ? (await d.bids.listBids(id)).find((b) => b.id === selId) : null;
        if (!chosen || chosen.agent_did !== s.agent_did) return reply({ error: 'only the agent selected for this job may deliver' }, 403);
      }
      const why = d.scamScreen ? d.scamScreen(s.builder, `${s.notes || ''} ${s.repo_or_patch_url}`) : null;
      if (why) return reply({ error: `refused: ${why}` }, 422);
      const day = new Date(now() - 24 * 3600_000).toISOString();
      if (await d.store.countSubmissions(day) >= SUBMISSIONS_GLOBAL_DAILY) return reply({ error: 'too many submissions today, try tomorrow' }, 429);
      if (await d.store.countSubmissions(day, s.contact, id) >= SUBMISSIONS_PER_CONTACT_DAILY) return reply({ error: `at most ${SUBMISSIONS_PER_CONTACT_DAILY} submissions a day per job` }, 429);
      const rec: Submission = { ...s, id: rid(), job_id: id, status: 'received', created_at: new Date(now()).toISOString() };
      await d.store.insertSubmission(rec);
      return reply({ submission: { id: rec.id, job_id: id, status: rec.status, created_at: rec.created_at } }, 201);
    }
    if ((req.method === 'POST' && !id) || (req.method === 'PUT' && id && !sub)) {
      if (!d.adminAddress || !BASE_ADDR.test(d.adminAddress)) return reply({ error: 'posting jobs is closed' }, 403);
      const raw = await req.text(); if (raw.length > MAX_SPEC_BYTES + 4096) return reply({ error: 'body too large' }, 413);
      let body: any; try { body = JSON.parse(raw); } catch { return reply({ error: 'body must be JSON' }, 400); }
      const sig = req.headers.get('x-lax-signature') || '', time = req.headers.get('x-lax-time') || '';
      const t = Date.parse(time);
      const path = id ? `/jobs/${id}` : '/jobs';
      const hash = await d.sha256Hex(d.canonicalJson(body));
      if (!sig || !Number.isFinite(t) || Math.abs(now() - t) > SIG_WINDOW_MS) return reply({ error: 'x-lax-signature and a fresh x-lax-time are required', message_format: jobsMessage(req.method, path, '<ISO time>', hash) }, 401);
      if (!(await d.verifyMessage({ address: d.adminAddress, message: jobsMessage(req.method, path, time, hash), signature: sig }))) return reply({ error: 'the signature is not Kognai\'s' }, 401);
      if (req.method === 'POST') {
        const v = validateJob(body, now());
        const job: Job = { ...v, id: rid(), status: 'open', created_by: d.adminAddress, created_at: new Date(now()).toISOString() };
        await d.store.insertJob(job);
        return reply({ job: publicJob(job) }, 201);
      }
      const j = await d.store.getJob(id!); if (!j) return reply({ error: 'not found' }, 404);
      const patch: Partial<Job> = {};
      if (body.status !== undefined) { if (!(JOB_STATUSES as readonly string[]).includes(body.status)) throw new Bad(`status must be one of ${JOB_STATUSES.join(', ')}`); patch.status = body.status; }
      if (body.deadline !== undefined) { const dl = Date.parse(String(body.deadline)); if (!Number.isFinite(dl)) throw new Bad('deadline must be an ISO time'); patch.deadline = new Date(dl).toISOString(); }
      if (body.summary !== undefined) patch.summary = str(body.summary, 'summary', 20, 600);
      // bid_closes (Founder 2026-10-17: a tender's window extended by 7 days): a future time before the deadline
      if (body.bid_closes !== undefined) { const bc = Date.parse(String(body.bid_closes)), dl = Date.parse(String(patch.deadline || j.deadline)); if (!Number.isFinite(bc) || bc <= now() || bc >= dl) throw new Bad('bid_closes must be a future time before the deadline'); (patch as any).bid_closes = new Date(bc).toISOString(); }
      patch.updated_at = new Date(now()).toISOString();
      await d.store.updateJob(id!, patch);
      return reply({ job: publicJob({ ...j, ...patch }) });
    }
    return reply({ error: 'not found' }, 404);
  } catch (e) {
    if (e instanceof Bad) return reply({ error: e.message }, 400);
    throw e;
  }
}
