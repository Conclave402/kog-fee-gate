/** In memory stores for the LAX registry handler: the same interfaces the registry uses on its database. */
import type { Row, Store } from '../registry/handler.ts';
import type { Job, JobStore, Submission } from '../registry/jobs.ts';
import type { Bid, BidStore } from '../registry/bids.ts';
import type { DeliveryRow, PactAnswerRow, PactStore } from '../registry/pact.ts';

export interface MemoryStores {
  store: Store & { agents: Map<string, Row> };
  jobStore: JobStore & { jobs: Map<string, Job>; submissions: Submission[] };
  bidStore: BidStore & { bids: Map<string, Bid> };
  pactStore: PactStore & { answers: PactAnswerRow[]; deliveries: DeliveryRow[] };
}

export function memoryStores(now: () => number): MemoryStores {
  const agents = new Map<string, Row>();
  const payments = new Map<string, { payer: string; status: string; created_at: string; valid_before: number; agent_id: string | null }>();
  const iso = () => new Date(now()).toISOString();
  const store: MemoryStores['store'] = {
    agents,
    async listListed() { return [...agents.values()].filter((r) => r.listed); },
    async getAgent(id) { return agents.get(id) || null; },
    async insertAgent(row) { agents.set(row.id, { ...row, created_at: row.created_at || iso() }); },
    async deleteAgent(id) { agents.delete(id); },
    async updateAgent(id, patch) { const r = agents.get(id); if (r) agents.set(id, { ...r, ...patch }); },
    async claimNonce(p) { if (payments.has(p.nonce)) return false; payments.set(p.nonce, { payer: p.payer, status: 'pending', created_at: iso(), valid_before: p.valid_before, agent_id: null }); return true; },
    async releaseNonce(n) { const p = payments.get(n); if (p && (p.status === 'pending' || p.status === 'unknown')) payments.delete(n); },
    async settleNonce(n) { const p = payments.get(n); if (p) p.status = 'settled'; },
    async markUnknown(n, agentId) { const p = payments.get(n); if (p) { p.status = 'unknown'; p.agent_id = agentId; } },
    async listUnknown(f) {
      return [...payments.entries()].filter(([n, p]) => p.status === 'unknown' && (!f.payer || p.payer === f.payer) && (!f.nonce || n === f.nonce))
        .map(([nonce, p]) => ({ nonce, payer: p.payer, agent_id: p.agent_id, valid_before: p.valid_before }));
    },
    async countPayments(since, payer) { return [...payments.values()].filter((p) => p.created_at >= since && (!payer || p.payer === payer)).length; },
    async setAiax(id, p) { const r = agents.get(id); if (r) agents.set(id, { ...r, ...p }); },
    async listAiaxDue(before, limit) { return [...agents.values()].filter((r) => r.listed && (!r.aiax_checked_at || r.aiax_checked_at < before)).slice(0, limit); },
  };
  const jobs = new Map<string, Job>(); const submissions: Submission[] = [];
  const jobStore: MemoryStores['jobStore'] = {
    jobs, submissions,
    async listJobs(f) { return [...jobs.values()].filter((j) => (!f?.status || f.status.includes(j.status)) && (!f?.track || j.track === f.track)); },
    async getJob(id) { return jobs.get(id) || null; },
    async insertJob(j) { jobs.set(j.id, j); },
    async updateJob(id, p) { const j = jobs.get(id); if (j) jobs.set(id, { ...j, ...p }); },
    async insertSubmission(s) { submissions.push(s); },
    async countSubmissions(since, contact, jobId) { return submissions.filter((s) => s.created_at >= since && (!contact || s.contact === contact) && (!jobId || s.job_id === jobId)).length; },
  };
  const bids = new Map<string, Bid>();
  const bidStore: MemoryStores['bidStore'] = {
    bids,
    async getBid(j, o) { return [...bids.values()].find((b) => b.job_id === j && b.offer_id === o) || null; },
    async listBids(j) { return [...bids.values()].filter((b) => b.job_id === j); },
    async upsertBid(b) { bids.set(b.id, b); },
    async updateBid(id, p) { const b = bids.get(id); if (b) bids.set(id, { ...b, ...p }); },
  };
  const answers: PactAnswerRow[] = []; const deliveries: DeliveryRow[] = []; const used = new Set<string>();
  const pactStore: MemoryStores['pactStore'] = {
    answers, deliveries,
    async insertAnswer(r) { answers.push(r); },
    async listAnswers(j, o) { return answers.filter((a) => a.job_id === j && a.offer_id === o); },
    async insertDelivery(r) { deliveries.push(r); },
    async listDeliveries(j, o) { return deliveries.filter((x) => x.job_id === j && x.offer_id === o); },
    async claimSignature(h) { if (used.has(h)) return false; used.add(h); return true; },
  };
  return { store, jobStore, bidStore, pactStore };
}
