/**
 * The LAX registry handler harness, kit version 1: the registry's own request handler (registry/, copied unchanged
 * from Kognai's registry 0.10.0), in memory stores, a mocked x402 facilitator for the USDC listing payment, and the
 * KOG fee gate in front of POST /offers and POST /jobs/<id>/bids. No network, no database, no key of Kognai's.
 *
 *   const h = createHarness();
 *   const res = await h.handle(h.offerRequest({ agent: h.agents[0] }));   // 402 with a KOG quote
 */
import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { canonicalJson, createHandler, PAY_TO, sha256Hex } from '../registry/handler.ts';
import { bidMessage } from '../registry/bids.ts';
import type { Job } from '../registry/jobs.ts';
import { checkPayment, KOG_FEES, KOG_MINT, KOG_PAYEE, kogFeeGate, usedFees, type GatedRoute, type KogPayment, type KogQuote, type UsedFees, type Verify } from './kog-fee.ts';
import { memoryStores, type MemoryStores } from './memory-store.ts';

export const HARNESS_VERSION = 1;
export const BASE = 'https://lax.test/registry';
export const START = Date.parse('2026-10-22T12:00:00.000Z');
/** The well known public test keys of local Ethereum dev chains (anvil accounts 1 to 3): never funded. */
const TEST_KEYS = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
] as const;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58 = (bytes: Uint8Array) => { let n = BigInt('0x' + Buffer.from(bytes).toString('hex')); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } return s || '1'; };

export interface Agent { name: string; address: string; did: string; solana: string; signMessage(p: { message: string }): Promise<string> }
export interface HarnessOptions {
  /** the clock start, milliseconds since the epoch (2026-10-22T12:00:00Z by default) */
  now?: number;
  /** the payment check of the gate (default checkPayment); production uses verifyKogFee over the parsed transaction */
  verify?: Verify;
  /** where spent fees are kept (default in memory) */
  used?: UsedFees;
  /** the gated routes (default both) */
  gated?: GatedRoute[];
}
export interface Harness {
  version: number; base: string;
  /** the registry behind the KOG fee gate */
  handle(req: Request): Promise<Response>;
  /** the clock: set clock.now to move time */
  clock: { now: number };
  kog: { mint: string; payee: string; fees: { offer: string; bid: string }; decimals: number };
  stores: MemoryStores; chain: Map<string, KogPayment>; quotes: Map<string, KogQuote>; used: UsedFees;
  /** three test agents (public test keys) */
  agents: Agent[];
  /** a valid LAX offer for an agent */
  offer(agent: Agent, over?: Record<string, unknown>): Record<string, unknown>;
  /** POST /offers with a valid offer and a valid USDC listing payment; KOG headers only when given */
  offerRequest(o: { agent: Agent; body?: unknown; quote?: KogQuote | string; fee?: string }): Request;
  /** an open tender (a job with a bid window), straight into the store; returns its id */
  seedJob(over?: Partial<Job>): string;
  /** a listed outside offer for an agent, straight into the store (no fee); returns its id */
  seedListing(agent: Agent): string;
  /** POST /jobs/<id>/bids signed by the listing owner; KOG headers only when given */
  bidRequest(o: { agent: Agent; jobId: string; offerId: string; body?: Record<string, unknown>; quote?: KogQuote | string; fee?: string }): Promise<Request>;
  /** pays in KOG on the harness chain and returns the transaction signature (amount: the quote's by default) */
  payKog(o: { quote: KogQuote; amount?: string; mint?: string; payee?: string; from?: Agent; at?: number; ok?: boolean }): string;
  /** the quote of a 402 answer */
  quoteOf(res: Response): Promise<KogQuote>;
}

export function createHarness(opts: HarnessOptions = {}): Harness {
  const clock = { now: opts.now ?? START };
  const now = () => clock.now;
  let n = 0; const id = () => `t${++n}`;
  const stores = memoryStores(now);
  // the x402 facilitator of the USDC listing payment, mocked: it accepts every well formed payment
  const facilitator = (async (url: string) => {
    const path = new URL(String(url)).pathname;
    if (path === '/verify') return Response.json({ isValid: true });
    if (path === '/settle') return Response.json({ success: true, transaction: '0x' + 'ab'.repeat(32), network: 'base' });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  const noAiax = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
  const inner = createHandler({
    store: stores.store, fetch: facilitator, aiaxFetch: noAiax, now, randomId: () => `lax-${id()}`, rpcUrl: 'https://rpc.invalid',
    jobs: { store: stores.jobStore, adminAddress: null, bids: stores.bidStore, pact: stores.pactStore },
    verifyMessage: ({ address, message, signature }) => verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` }),
  });
  const chain = new Map<string, KogPayment>(); const quotes = new Map<string, KogQuote>(); const used = opts.used || usedFees();
  const handle = kogFeeGate(inner, { now, newId: id, chain, quotes, used, verify: opts.verify || checkPayment, gated: opts.gated || ['offers', 'bids'], fees: { ...KOG_FEES }, mint: KOG_MINT, payee: KOG_PAYEE });

  const agents: Agent[] = TEST_KEYS.map((k, i) => {
    const a = privateKeyToAccount(k); const name = `agent-${'abc'[i]}`;
    return { name, address: a.address, did: `did:web:${name}.example`, solana: base58(new Uint8Array(32).fill(i + 7)), signMessage: (p) => a.signMessage(p) };
  });
  const offer = (agent: Agent, over: Record<string, unknown> = {}) => ({
    lax_version: '1.0', name: `Test ${agent.name}`, description: 'A test agent that translates short documents and answers in plain words.', category: 'Testing',
    agent_did: agent.did, capabilities: [{ skill_id: 'translate', description: 'Translate up to 2000 words', pricing: { model: 'per_call', amount: '0.05', currency: 'USDC', rail: 'x402' } }],
    constitutional_constraints: ['Solidarity Oath', 'Renewal Mandate', 'Treasury Equilibrium', 'Harm Shield', 'Transparency Covenant'],
    endpoint: `https://${agent.name}.example/api`, payment_rails: ['x402'], ...over,
  });
  const usdcPayment = (agent: Agent) => Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'base', payload: {
    signature: '0x' + 'ab'.repeat(65),
    authorization: { from: agent.address, to: PAY_TO, value: '10000', validAfter: '0', validBefore: String(Math.floor(now() / 1000) + 600), nonce: '0x' + randomBytes(32).toString('hex') },
  } })).toString('base64');
  const kogHeaders = (quote?: KogQuote | string, fee?: string): Record<string, string> => ({
    ...(quote ? { 'x-kog-quote': typeof quote === 'string' ? quote : quote.quote_id } : {}), ...(fee ? { 'x-kog-fee': fee } : {}),
  });

  return {
    version: HARNESS_VERSION, base: BASE, handle, clock, kog: { mint: KOG_MINT, payee: KOG_PAYEE, fees: { ...KOG_FEES }, decimals: 6 }, stores, chain, quotes, used, agents,
    offer,
    offerRequest: ({ agent, body, quote, fee }) => new Request(`${BASE}/offers`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment': usdcPayment(agent), ...kogHeaders(quote, fee) }, body: JSON.stringify(body ?? offer(agent)) }),
    seedJob: (over = {}) => {
      const jid = `job-${id()}`; const iso = (ms: number) => new Date(ms).toISOString();
      stores.jobStore.jobs.set(jid, { id: jid, title: 'Test tender', track: 'seat', summary: 'A test tender with a bid window, for the harness.', spec_md: 'Build a test module with tests for every acceptance item.', skills: ['typescript'],
        bounty_usdc: 60, currency: 'USDC', chain: 'base', deadline: iso(now() + 14 * 86400_000), status: 'open', created_by: '0x' + '0'.repeat(40), created_at: iso(now()), bid_closes: iso(now() + 2 * 86400_000), ...over } as Job);
      return jid;
    },
    seedListing: (agent) => {
      const oid = `lax-ext-${id()}`;
      stores.store.agents.set(oid, { id: oid, name: `Test ${agent.name}`, slug: oid, listed: true, origin: 'outside', verified: false, owner_address: agent.address, agent_did: agent.did, offer: offer(agent) as any, created_at: new Date(now()).toISOString() });
      return oid;
    },
    bidRequest: async ({ agent, jobId, offerId, body, quote, fee }) => {
      const b = body ?? { offer_id: offerId, price_usdc: 50, delivery_by: new Date(now() + 5 * 86400_000).toISOString(), approach_md: 'A TypeScript module with node:test tests for every acceptance item, delivered at an exact commit.', settlement: { chain: 'base', payee: agent.address } };
      const path = `/jobs/${jobId}/bids`; const time = new Date(now()).toISOString();
      const signature = await agent.signMessage({ message: bidMessage('POST', path, time, await sha256Hex(canonicalJson(b))) });
      return new Request(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lax-signature': signature, 'x-lax-time': time, ...kogHeaders(quote, fee) }, body: JSON.stringify(b) });
    },
    payKog: ({ quote, amount, mint, payee, from, at, ok }) => {
      const signature = base58(randomBytes(64));
      chain.set(signature, { signature, mint: mint ?? quote.mint, payee: payee ?? quote.payee, amount: amount ?? quote.amount, from: (from || agents[0]).solana, block_time: new Date(at ?? now()).toISOString(), ok: ok ?? true });
      return signature;
    },
    quoteOf: async (res) => { const j: any = await res.clone().json(); if (!j?.kog_fee?.quote_id) throw new Error(`no KOG quote in this answer (${res.status})`); return j.kog_fee as KogQuote; },
  };
}
