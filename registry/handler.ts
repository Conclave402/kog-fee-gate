// LAX Registry handler, 0.6.0 (Founder go 2026-09-30: the registry is open to outside agents).
//
// Pure request handler with every side effect injected (store, facilitator fetch, EIP-191
// verification, clock), so it runs unchanged on Supabase Edge (index.ts wires the real deps)
// and under node for the tests (handler.test.ts wires mocks). No runtime specific imports here.
//
// Routes (path segments after the function name, or after /registry on lax.kognai.ai):
//   GET    /search                 public discovery, listed rows only, proven agents first
//   GET    /offers/<id>            one listed offer
//   POST   /offers                 list an outside agent: offer validated FIRST, then x402
//                                  (exact on Base, 0.01 USDC; v2 by default since 0.7.1, the v1
//                                  X-PAYMENT of older clients still accepted): verify, insert,
//                                  settle; a failed settle deletes the row and answers 402
//   PUT    /offers/<id>            owner update, free, EIP-191 signed (x-lax-signature, x-lax-time);
//                                  the message binds the sha256 of the canonical JSON body (canonicalJson)
//   DELETE /offers/<id>            owner delist, free, EIP-191 signed
//   POST   /reconcile              decide rows whose settle outcome is unknown, from USDC
//                                  authorizationState on Base (also run inline for the same payer)
//   GET/POST/PUT /jobs...           LAX jobs (0.8.0, Genesis P1): see jobs.ts; tender bids and selection (0.9.0): bids.ts;
//                                  the selected agent's PACT, answer and milestone deliveries (0.10.0): pact.ts
//   GET    /                       info
//
// Outside listings are listed=true, origin='outside', verified=false, score 0 shown as
// "unproven" (never a made up score). Moderation kill: scripts/labor/lax-moderate.ts.

export const VERSION = '0.10.0';

// ── x402 constants ("exact" on Base mainnet; v2 CAIP network eip155:8453, v1 name base) ──
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BASE_CAIP = 'eip155:8453';
export const PAY_TO = '0xF62fb064F9d9D03B8013E5b6023e3501805BA973'; // Kognai Base receiving wallet
export const LISTING_FEE_ATOMIC = '10000'; // 0.01 USDC (6 decimals)
export const RESOURCE = 'https://lax.kognai.ai/registry/offers';
export const FACILITATOR_URL = 'https://facilitator.payai.network';

export const PER_PAYER_DAILY = 5;
export const GLOBAL_DAILY = 100;
export const SIG_WINDOW_MS = 5 * 60 * 1000;
export const BASE_RPC_URL = 'https://mainnet.base.org';
/** An authorization may be valid for at most 1 hour, so an unknown settle is decided within the hour. */
export const MAX_VALIDITY_S = 3600;
export const MAX_BODY_BYTES = 16 * 1024;

// The Five Immutable Laws (Founding Charter Article I). An outside agent accepts all five.
export const LAWS = ['Solidarity Oath', 'Renewal Mandate', 'Treasury Equilibrium', 'Harm Shield', 'Transparency Covenant'];

import { handleJobs, type JobStore } from './jobs.ts';
import type { BidStore } from './bids.ts';
import type { PactStore } from './pact.ts';

// ── Types ───────────────────────────────────────────────────────────────────
export interface Row {
  id: string; name: string; slug: string; description?: string | null;
  score?: number | null; capabilities?: string[] | null; category?: string | null; created_at?: string | null;
  rate_usdc?: number | string | null; listed?: boolean;
  origin?: string | null; verified?: boolean | null; owner_address?: string | null; payer?: string | null;
  endpoint?: string | null; pact_endpoint?: string | null; agent_did?: string | null;
  offer?: StoredOffer | null; updated_at?: string | null; owner_signed_at?: string | null;
  delisted_by?: string | null; delisted_reason?: string | null; builder?: string | null;
  /** 'pending' (settling now) | 'settled' | 'unknown' (outcome unknown, kept unlisted until reconcile) */
  settle_state?: string | null;
  /** AIAX ready (0.7.0): the agent's base URL serves a valid AIAX v0.1 manifest. */
  aiax_ready?: boolean | null; aiax_manifest?: string | null; aiax_checked_at?: string | null;
}

export interface PendingPayment { nonce: string; payer: string; agent_id: string | null; valid_before: number }

export interface Capability {
  skill_id: string; description: string;
  input_schema: Record<string, unknown>; output_schema: Record<string, unknown>;
  pricing: { model: string; amount: string; currency: 'USDC'; rail: 'x402' };
}

export interface StoredOffer {
  name: string; description: string; category: string;
  agent_did: string | null; erc8004_identity: string; soul_uri: string | null;
  capabilities: Capability[]; constitutional_constraints: string[];
  endpoint: string | null; pact_endpoint: string | null; payment_rails: string[];
}

export interface Store {
  listListed(): Promise<Row[]>;
  getAgent(id: string): Promise<Row | null>;
  insertAgent(row: Row): Promise<void>;
  deleteAgent(id: string): Promise<void>;
  updateAgent(id: string, patch: Partial<Row>): Promise<void>;
  /** Claim an authorization nonce. false when it was already used (replay). */
  claimNonce(p: { nonce: string; payer: string; amount_atomic: string; valid_before: number }): Promise<boolean>;
  /** Forget a claimed nonce that was never paid (status pending or unknown). */
  releaseNonce(nonce: string): Promise<void>;
  settleNonce(nonce: string, p: { agent_id: string; tx_hash: string | null }): Promise<void>;
  /** Settle outcome unknown: keep the nonce claimed and remember the row. */
  markUnknown(nonce: string, agent_id: string): Promise<void>;
  /** Payments whose settle outcome is unknown, optionally for one payer or one nonce. */
  listUnknown(filter: { payer?: string; nonce?: string; limit?: number }): Promise<PendingPayment[]>;
  /** Paid listing attempts (pending or settled) since the given time; payer optional. */
  countPayments(sinceIso: string, payer?: string): Promise<number>;
  /** Record an AIAX probe on any row (Kognai rows too). */
  setAiax(id: string, p: { aiax_ready: boolean; aiax_manifest: string | null; aiax_checked_at: string }): Promise<void>;
  /** Listed rows never probed or probed before the given time, oldest check first. */
  listAiaxDue(beforeIso: string, limit: number): Promise<Row[]>;
}

export interface Deps {
  store: Store;
  fetch: typeof fetch;
  verifyMessage: (p: { address: string; message: string; signature: string }) => Promise<boolean>;
  now?: () => number;
  randomId?: () => string;
  facilitatorUrl?: string;
  rpcUrl?: string;
  /** fetch for the AIAX manifest probe (defaults to fetch). */
  aiaxFetch?: typeof fetch;
  /** LAX jobs (0.8.0, Genesis P1): the job store and the Kognai poster address; absent, the /jobs routes answer 404 */
  jobs?: { store: JobStore; adminAddress?: string | null; bids?: BidStore; pact?: PactStore };
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-expose-headers': 'X-PAYMENT-RESPONSE, PAYMENT-RESPONSE, PAYMENT-REQUIRED',
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS, ...extra } });

// x402 discovery (0.6.2, 2026-10-12): v1 "outputSchema" on the requirements, which the PayAI facilitator reads on
// /verify and /settle to list the resource in its Bazaar (docs.payai.network/x402/facilitators/bazaar; a POST
// resource is listed on its first settled payment). No names of people, Latin digits, no dashes, at most 500 characters.
export const DISCOVERY_DESCRIPTION =
  'LAX registry by Kognai: list your AI agent in the Linked Agent eXchange so Kognai citizens, agents and outside buyers can find and hire it. ' +
  'Send your offer as the JSON body: name, description, an https endpoint, capabilities priced in USDC over x402, and the Five Laws accepted. ' +
  'Use it when your agent sells a service and wants buyers. Listing fee 0.01 USDC on Base. Kognai never asks for keys or seed phrases. ' +
  'AIAX manifest at https://lax.kognai.ai/aiax/manifest.json.';
export const AIAX_MANIFEST_URL = 'https://lax.kognai.ai/aiax/manifest.json';
export const OUTPUT_SCHEMA = {
  input: {
    type: 'http', method: 'POST', discoverable: true, bodyType: 'json',
    bodyFields: {
      lax_version: { type: 'string', enum: ['1.0'], description: 'optional, 1.0' },
      name: { type: 'string', minLength: 3, maxLength: 80, description: 'the agent name' },
      description: { type: 'string', minLength: 20, maxLength: 600, description: 'what the agent does' },
      category: { type: 'string', description: 'optional, 2 to 40 characters' },
      endpoint: { type: 'string', description: 'https url of the agent (endpoint or pact_endpoint is required)' },
      pact_endpoint: { type: 'string', description: 'optional https url for pacts' },
      agent_did: { type: 'string', description: 'optional did:method:identifier' },
      erc8004_identity: { type: 'string', description: 'optional address or eip155:chain:address' },
      capabilities: { type: 'array', minItems: 1, maxItems: 10, description: 'skill_id, description, pricing { model per_call, per_minute, flat or free; amount like "0.05"; currency USDC; rail x402 }, optional input_schema and output_schema' },
      constitutional_constraints: { type: 'array', description: `must include the Five Laws: ${LAWS.join(', ')}` },
      payment_rails: { type: 'array', description: 'optional: x402, usdc or usdc-base' },
    },
  },
  output: { ok: true, id: 'agent id', offer: { name: 'Example Agent', verified: false }, transaction: '0x...', note: 'Listed as unproven, not verified by Kognai.' },
};

/** The v1 requirement (older clients: X-PAYMENT with x402Version 1; also shown as accepts_v1 in the 402). */
export function paymentRequirements() {
  return {
    scheme: 'exact',
    network: 'base',
    maxAmountRequired: LISTING_FEE_ATOMIC,
    resource: RESOURCE,
    description: DISCOVERY_DESCRIPTION,
    mimeType: 'application/json',
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    asset: USDC_BASE,
    outputSchema: OUTPUT_SCHEMA,
    extra: { name: 'USD Coin', version: '2' },
  };
}
/** The v2 requirement (0.7.1, 2026-10-12): CAIP network, amount; the resource and description move to the 402 body. */
export function paymentRequirementsV2() {
  return { scheme: 'exact', network: BASE_CAIP, amount: LISTING_FEE_ATOMIC, asset: USDC_BASE, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' } };
}

// x402 v2 discovery (0.7.1): the same declaration the Kreativ and Golden Kog doors make (scripts/kreativ/api/rail.ts
// bazaarExtension, the shape @x402/extensions declareDiscoveryExtension builds), built here without imports so the
// handler stays runtime free. PayAI and the CDP Bazaar read it from paymentPayload.extensions.bazaar and
// paymentPayload.resource on /verify and /settle; the payment we forward always carries OUR declaration (withDiscovery).
export const EXAMPLE_OFFER = {
  name: 'Example Agent', description: 'Makes short product videos from a text brief.', endpoint: 'https://agent.example.com/v1/video',
  capabilities: [{ skill_id: 'video.short', description: 'one short video', pricing: { model: 'per_call', amount: '0.50', currency: 'USDC', rail: 'x402' } }],
  constitutional_constraints: LAWS,
};
export const DISCOVERY_SPEC = {
  method: 'POST' as const,
  example: EXAMPLE_OFFER,
  inputSchema: { properties: OUTPUT_SCHEMA.input.bodyFields as Record<string, unknown>, required: ['name', 'description', 'capabilities', 'constitutional_constraints'] },
  output: OUTPUT_SCHEMA.output as Record<string, unknown>,
  outputSchema: {
    properties: {
      ok: { type: 'boolean' }, id: { type: 'string', description: 'the listing id' },
      offer: { type: 'object', description: 'the listed offer, unproven until verified' },
      transaction: { type: ['string', 'null'], description: 'the Base transaction of the listing fee' },
      note: { type: 'string' },
    },
    required: ['ok', 'id'],
  },
};
export const RESOURCE_META = { url: RESOURCE, description: DISCOVERY_DESCRIPTION, mimeType: 'application/json', serviceName: 'LAX registry by Kognai', tags: ['agent registry', 'discovery', 'x402', 'listing'] };
export const AIAX_EXTENSION = { manifest: AIAX_MANIFEST_URL, spec: 'https://github.com/Godman-s/aiax', version: '0.1' };
export function bazaarExtension(spec = DISCOVERY_SPEC) {
  return {
    info: { input: { type: 'http', method: 'POST', bodyType: 'json', body: spec.example }, output: { type: 'json', example: spec.output } },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['input'],
      properties: {
        input: {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'http' }, method: { type: 'string', enum: ['POST', 'PUT', 'PATCH'] },
            bodyType: { type: 'string', enum: ['json', 'form-data', 'text'] }, body: { type: 'object', ...spec.inputSchema },
          },
          required: ['type', 'method', 'bodyType', 'body'], additionalProperties: false,
        },
        output: { type: 'object', properties: { type: { type: 'string' }, example: { type: 'object', ...spec.outputSchema } }, required: ['type'] },
      },
    },
  };
}
/** The payment the facilitator sees: our resource and declaration; the aiax pointer is for buyers, never forwarded. */
export function withDiscovery(envelope: Record<string, unknown>): Record<string, unknown> {
  const ext = envelope.extensions && typeof envelope.extensions === 'object' ? { ...(envelope.extensions as Record<string, unknown>) } : {};
  delete ext.aiax;
  return { ...envelope, resource: RESOURCE_META, extensions: { ...ext, bazaar: bazaarExtension() } };
}
// The 402: x402 v2 in the body and, base64, in the PAYMENT-REQUIRED header (resource, accepts, extensions.bazaar and
// extensions.aiax); the v1 terms stay beside it as accepts_v1 and x402_v1 for older clients. Nothing goes inside
// accepts[].extra, which the facilitator reads as the EIP-712 domain.
const paymentRequired = (error: string) => {
  const v2 = { x402Version: 2, error, resource: RESOURCE_META, accepts: [paymentRequirementsV2()], extensions: { bazaar: bazaarExtension(), aiax: AIAX_EXTENSION } };
  const v1 = [paymentRequirements()];
  return json({ ...v2, accepts_v1: v1, x402_v1: { x402Version: 1, accepts: v1 } }, 402, { 'PAYMENT-REQUIRED': b64encode(JSON.stringify(v2)) });
};

// ── AIAX ready (0.7.0) ──────────────────────────────────────────────────────
// An agent is "AIAX ready" when its base URL serves a valid AIAX v0.1 Tier 0 manifest
// (workspace/godman-protocols/aiax/schemas/manifest.schema.json). Shown as a badge, and a small ranking boost.
// Built from parts: the Supabase CLI bundler reads a quoted '/x.json' literal as a static file to upload.
const JSON_EXT = '.json';
export const AIAX_PATHS = ['/aiax/manifest' + JSON_EXT, '/.well-known/aiax' + JSON_EXT];
/** A tie breaker: below one score point (x10 in rank) and below the Kognai verified +1. */
export const AIAX_RANK_BOOST = 0.5;
export const AIAX_RECHECK_MS = 24 * 60 * 60 * 1000;
export const AIAX_MAX_BYTES = 64 * 1024;
const AIAX_ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Minimal AIAX v0.1 Tier 0 manifest check (the required fields of the schema). */
export function validAiaxManifest(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  if (m.aiax_version !== '0.1') return false;
  const p = m.product as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object' || !isStr(p.name) || !isStr(p.one_line_purpose) || !isStr(p.domain)) return false;
  if (!Array.isArray(m.entry_points) || m.entry_points.length === 0) return false;
  for (const e of m.entry_points as unknown[]) {
    if (!e || typeof e !== 'object') return false;
    const x = e as Record<string, unknown>;
    if (typeof x.id !== 'string' || !AIAX_ID_RE.test(x.id) || !isStr(x.url) || !isStr(x.purpose)) return false;
    if (!Number.isInteger(x.est_tokens) || (x.est_tokens as number) < 1 || (x.est_tokens as number) > 5000) return false;
  }
  if (!('pricing_summary' in m) || !(m.pricing_summary === null || typeof m.pricing_summary === 'string')) return false;
  if (!m.trust_signals || typeof m.trust_signals !== 'object' || Array.isArray(m.trust_signals)) return false;
  if (!('mcp_endpoint' in m) || !(m.mcp_endpoint === null || typeof m.mcp_endpoint === 'string')) return false;
  if (typeof m.updated_at !== 'string' || !Number.isFinite(Date.parse(m.updated_at))) return false;
  return true;
}

/** The origin to probe: https, a public domain name (no IP, no local names, no punycode, no credentials). */
export function aiaxOrigin(endpoint: string): string | null {
  let u: URL;
  try { u = new URL(endpoint); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || /\.(local|internal|localhost|lan|home|onion)$/.test(h)) return null;
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return null;
  if (h.split('.').some((x) => x.startsWith('xn--'))) return null;
  if (u.port && u.port !== '443') return null;
  return u.origin;
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  const len = Number(res.headers.get('content-length') || '0');
  if (len > max) return null;
  if (!res.body) { const t = await res.text(); return t.length > max ? null : t; }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(total); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** Probe an agent's base URL for an AIAX manifest. Never throws: any error = not ready. */
export async function probeAiax(f: typeof fetch, endpoint: string | null | undefined, timeoutMs = 4000): Promise<{ ready: boolean; manifest: string | null }> {
  const origin = endpoint ? aiaxOrigin(endpoint) : null;
  if (!origin) return { ready: false, manifest: null };
  for (const path of AIAX_PATHS) {
    const url = origin + path;
    try {
      const res = await f(url, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 200) continue;
      const text = await readCapped(res, AIAX_MAX_BYTES);
      if (text === null) continue;
      if (validAiaxManifest(JSON.parse(text))) return { ready: true, manifest: url };
    } catch { /* next path */ }
  }
  return { ready: false, manifest: null };
}

const aiaxView = (row: Row) => row.aiax_ready && row.aiax_manifest
  ? { aiax_ready: true, aiax_manifest: row.aiax_manifest, badges: ['AIAX ready'] }
  : { aiax_ready: false };

// ── Offer validation ────────────────────────────────────────────────────────
class Bad extends Error {}

const HTML_RE = /[<>]|javascript:|data:text\/html/i;
// deno-lint-ignore no-control-regex
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/;

function text(v: unknown, field: string, min: number, max: number, opts: { multiline?: boolean } = {}): string {
  if (typeof v !== 'string') throw new Bad(`${field} must be a string`);
  const s = v.trim();
  if (s.length < min) throw new Bad(`${field} must be at least ${min} characters`);
  if (s.length > max) throw new Bad(`${field} must be at most ${max} characters`);
  if (HTML_RE.test(s)) throw new Bad(`${field} must not contain HTML or scripts`);
  if (CTRL_RE.test(s) || (!opts.multiline && /[\r\n\t]/.test(s))) throw new Bad(`${field} contains control characters`);
  return s;
}

const SHORTENERS = new Set(['bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'is.gd', 'cutt.ly', 'ow.ly', 'rebrand.ly', 'buff.ly', 'shorturl.at', 't.ly']);

export function httpsUrl(v: unknown, field: string): string {
  const s = text(v, field, 10, 300);
  let u: URL;
  try { u = new URL(s); } catch { throw new Bad(`${field} must be a valid URL`); }
  if (u.protocol !== 'https:') throw new Bad(`${field} must be an https URL`);
  if (u.username || u.password) throw new Bad(`${field} must not carry credentials`);
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || /\.(local|internal|localhost|lan|home|onion)$/.test(h)) throw new Bad(`${field} must be a public host`);
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) throw new Bad(`${field} must use a domain name, not an IP address`);
  if (h.split('.').some((p) => p.startsWith('xn--'))) throw new Bad(`${field} must not use a punycode domain`);
  if (SHORTENERS.has(h)) throw new Bad(`${field} must not be a link shortener`);
  if (h === 'kognai.ai' || h.endsWith('.kognai.ai')) throw new Bad(`${field} must be your own domain, not kognai.ai`);
  return u.toString();
}

// Scam and phishing screen over the free text of an offer.
const SCAM: Array<[RegExp, string]> = [
  [/\b(seed|recovery|secret|backup)\s*(phrase|words?)\b/i, 'mentions a seed or recovery phrase'],
  [/\bmnemonic\b/i, 'mentions a mnemonic'],
  [/\bprivate\s*keys?\b/i, 'mentions private keys'],
  [/\b(12|24)\s*(secret\s*)?words\b/i, 'asks for secret words'],
  [/\b(validate|sync|rectify|restore|unlock|revalidate)\s+(your\s+)?wallets?\b/i, 'wallet drain bait'],
  [/\bair\s*drops?\b/i, 'airdrop bait'],
  [/\bpre\s*[-_ ]?\s*sales?\b/i, 'presale bait'],
  [/\bgive\s*aways?\b/i, 'giveaway bait'],
  [/\bclaim\s+(your|free|now|the|tokens?|rewards?|airdrops?|allocations?|bonus)\b/i, 'claim bait'],
  [/\bfree\s+(usdc|usdt|eth|sol|btc|crypto|tokens?|coins?)\b/i, 'free token bait'],
  [/\b(double|triple)\s+your\b/i, 'promises multiplied money'],
  [/\bguaranteed\s+(returns?|profits?|yields?|gains?)\b/i, 'promises guaranteed returns'],
  [/\b\d{2,}\s*x\s+(gains?|returns?|profits?)\b/i, 'promises multiplied returns'],
  [/pump\.fun|dexscreener|birdeye\.so|raydium|\bCA\s*:/i, 'token promotion'],
];
const EVM_ADDR = /0x[0-9a-fA-F]{40}/g;
const SOL_ADDR = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const IMPERSONATION = /\b(kognai|achiri|godman|official\s+kognai)\b/i;

export function scamScreen(name: string, freeText: string): string | null {
  if (IMPERSONATION.test(name)) return 'the name must not claim Kognai, Achiri or Godman';
  const all = `${name}\n${freeText}`;
  for (const [re, why] of SCAM) if (re.test(all)) return why;
  for (const m of all.match(EVM_ADDR) || []) {
    if (m.toLowerCase() !== USDC_BASE.toLowerCase()) return 'contains a token or wallet contract address';
  }
  for (const m of all.match(SOL_ADDR) || []) {
    if (/\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m)) return 'contains a token or wallet address';
  }
  return null;
}

const PRICING_MODELS = new Set(['per_call', 'per-call', 'per_minute', 'flat', 'free']);
const RAILS = new Set(['x402', 'usdc', 'usdc-base']);
const DID_RE = /^did:[a-z0-9]{2,20}:[A-Za-z0-9._:%-]{1,160}$/;
const ERC8004_RE = /^(0x[0-9a-fA-F]{40}|eip155:\d{1,10}:0x[0-9a-fA-F]{40}(:\d{1,20})?)$/;
const AMOUNT_RE = /^\d{1,7}(\.\d{1,6})?$/;

function smallSchema(v: unknown, field: string): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Bad(`${field} must be a JSON object`);
  const s = JSON.stringify(v);
  if (s.length > 2000) throw new Bad(`${field} must be at most 2000 characters of JSON`);
  if (HTML_RE.test(s)) throw new Bad(`${field} must not contain HTML or scripts`);
  return v as Record<string, unknown>;
}

/** Validate and normalise an outside offer. Throws Bad with a plain reason. */
export function validateOutsideOffer(body: unknown): StoredOffer {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Bad('the body must be a JSON offer object');
  const o = body as Record<string, unknown>;
  if (o.lax_version != null && o.lax_version !== '1.0') throw new Bad('lax_version must be "1.0"');

  const name = text(o.name, 'name', 3, 80);
  const description = text(o.description, 'description', 20, 600, { multiline: true });
  const category = o.category == null ? '' : text(o.category, 'category', 2, 40);

  const agent_did = o.agent_did == null || o.agent_did === '' ? null : text(o.agent_did, 'agent_did', 8, 200);
  if (agent_did && !DID_RE.test(agent_did)) throw new Bad('agent_did must look like did:method:identifier');
  if (agent_did && /^did:kognai:/i.test(agent_did)) throw new Bad('agent_did must not use the did:kognai method');
  const erc8004_identity = o.erc8004_identity == null || o.erc8004_identity === '' ? '' : text(o.erc8004_identity, 'erc8004_identity', 10, 120);
  if (erc8004_identity && !ERC8004_RE.test(erc8004_identity)) throw new Bad('erc8004_identity must be an address or eip155:chain:address[:tokenId]');

  const endpoint = o.endpoint == null || o.endpoint === '' ? null : httpsUrl(o.endpoint, 'endpoint');
  const pact_endpoint = o.pact_endpoint == null || o.pact_endpoint === '' ? null : httpsUrl(o.pact_endpoint, 'pact_endpoint');
  if (!endpoint && !pact_endpoint) throw new Bad('an https endpoint or pact_endpoint is required');
  const soul_uri = o.soul_uri == null || o.soul_uri === '' ? null : httpsUrl(o.soul_uri, 'soul_uri');

  if (!Array.isArray(o.capabilities) || o.capabilities.length < 1) throw new Bad('capabilities must be a non empty array');
  if (o.capabilities.length > 10) throw new Bad('at most 10 capabilities');
  const seen = new Set<string>();
  const capabilities: Capability[] = o.capabilities.map((c: unknown, i: number) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Bad(`capabilities[${i}] must be an object`);
    const cap = c as Record<string, unknown>;
    const skill_id = text(cap.skill_id, `capabilities[${i}].skill_id`, 2, 64).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(skill_id)) throw new Bad(`capabilities[${i}].skill_id may use letters, digits, dot, underscore and hyphen`);
    if (seen.has(skill_id)) throw new Bad(`capabilities[${i}].skill_id is repeated`);
    seen.add(skill_id);
    const cdesc = text(cap.description, `capabilities[${i}].description`, 3, 200);
    const p = cap.pricing as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') throw new Bad(`capabilities[${i}].pricing is required (price per call in USDC over x402)`);
    const model = String(p.model ?? '');
    if (!PRICING_MODELS.has(model)) throw new Bad(`capabilities[${i}].pricing.model must be per_call, per_minute, flat or free`);
    if (p.currency !== 'USDC') throw new Bad(`capabilities[${i}].pricing.currency must be USDC`);
    if (p.rail !== 'x402') throw new Bad(`capabilities[${i}].pricing.rail must be x402`);
    const amount = typeof p.amount === 'number' ? String(p.amount) : p.amount;
    if (typeof amount !== 'string' || !AMOUNT_RE.test(amount)) throw new Bad(`capabilities[${i}].pricing.amount must be a decimal string such as "0.05"`);
    if (Number(amount) > 1_000_000) throw new Bad(`capabilities[${i}].pricing.amount is too large`);
    if (model !== 'free' && Number(amount) <= 0) throw new Bad(`capabilities[${i}].pricing.amount must be above 0 unless the model is free`);
    return {
      skill_id, description: cdesc,
      input_schema: smallSchema(cap.input_schema, `capabilities[${i}].input_schema`),
      output_schema: smallSchema(cap.output_schema, `capabilities[${i}].output_schema`),
      pricing: { model, amount, currency: 'USDC', rail: 'x402' },
    };
  });

  if (!Array.isArray(o.constitutional_constraints)) throw new Bad('constitutional_constraints must list the Five Laws');
  if (o.constitutional_constraints.length > 15) throw new Bad('at most 15 constitutional_constraints');
  const declared = o.constitutional_constraints.map((c: unknown, i: number) => text(c, `constitutional_constraints[${i}]`, 2, 80));
  const lower = new Set(declared.map((c) => c.toLowerCase()));
  const missing = LAWS.filter((l) => !lower.has(l.toLowerCase()));
  if (missing.length) throw new Bad(`constitutional_constraints must accept the Five Laws; missing: ${missing.join(', ')}`);
  const lawSet = new Set(LAWS.map((l) => l.toLowerCase()));
  const constitutional_constraints = [...LAWS, ...declared.filter((c) => !lawSet.has(c.toLowerCase()))];

  const railsIn = o.payment_rails == null ? ['x402'] : o.payment_rails;
  if (!Array.isArray(railsIn) || railsIn.length < 1 || railsIn.length > 5) throw new Bad('payment_rails must be a short non empty array');
  const payment_rails = railsIn.map((r: unknown) => String(r).toLowerCase());
  if (payment_rails.some((r) => !RAILS.has(r))) throw new Bad('payment_rails may only contain x402, usdc or usdc-base');

  const freeText = [description, category, ...capabilities.flatMap((c) => [c.skill_id, c.description]), ...constitutional_constraints.slice(5)].join('\n');
  const scam = scamScreen(name, freeText);
  if (scam) throw new Bad(`refused by the scam screen: ${scam}`);

  return { name, description, category, agent_did, erc8004_identity, soul_uri, capabilities, constitutional_constraints, endpoint, pact_endpoint, payment_rails };
}

// ── Registry view ───────────────────────────────────────────────────────────
export function toOffer(row: Row) {
  const outside = row.origin === 'outside';
  if (outside && row.offer) {
    const o = row.offer;
    return {
      lax_version: '1.0',
      id: row.id,
      agent_did: o.agent_did || `did:lax:${row.id}`,
      name: row.name,
      description: row.description || '',
      category: row.category || '',
      erc8004_identity: o.erc8004_identity || '',
      ...(o.soul_uri ? { soul_uri: o.soul_uri } : {}),
      capabilities: o.capabilities,
      constitutional_constraints: o.constitutional_constraints,
      acp_score: 0,
      trust: 'unproven',
      origin: 'outside',
      verified: false,
      badge: 'unproven, not verified by Kognai',
      owner: row.owner_address || null,
      ...(o.endpoint ? { endpoint: o.endpoint } : {}),
      ...(o.pact_endpoint ? { pact_endpoint: o.pact_endpoint } : {}),
      payment_rails: o.payment_rails,
      ...aiaxView(row),
      updated_at: row.updated_at || row.created_at || new Date().toISOString(),
    };
  }
  // A Kognai row may carry a small hire note in `offer` (migration 20260930000002_lax_kognai_hire_endpoint):
  // {how_to_hire, price_usd?}; the direct hire endpoint is the `endpoint` column.
  const hireNote = (row.offer || {}) as { how_to_hire?: unknown; price_usd?: unknown };
  const howToHire = typeof hireNote.how_to_hire === 'string' && hireNote.how_to_hire ? hireNote.how_to_hire : null;
  const amount = typeof hireNote.price_usd === 'string' && /^\d+(\.\d+)?$/.test(hireNote.price_usd) ? hireNote.price_usd
    : Number(row.rate_usdc) > 0 ? Number(row.rate_usdc).toFixed(3) : null;
  return {
    lax_version: '1.0',
    id: row.id,
    agent_did: `did:kognai:${row.slug}`,
    name: row.name,
    description: row.description || '',
    category: row.category || '',
    erc8004_identity: '',
    soul_uri: 'https://kognai.ai/soul',
    capabilities: (row.capabilities || []).map((c) => ({
      skill_id: String(c), description: String(c),
      input_schema: {}, output_schema: {},
      pricing: { model: 'per-call', currency: 'USDC', rail: 'x402', ...(amount ? { amount } : {}) },
      ...(howToHire ? { how_to_hire: howToHire } : {}),
    })),
    constitutional_constraints: LAWS,
    acp_score: row.score ?? 0,
    trust: 'kognai',
    origin: 'kognai',
    verified: true,
    acp_attestation_uid: '',
    ...(row.endpoint ? { endpoint: row.endpoint } : {}),
    pact_endpoint: row.pact_endpoint || 'https://app.kognai.ai/api/lax/hire',
    payment_rails: ['x402', 'usdc'],
    ...aiaxView(row),
    updated_at: row.created_at || new Date().toISOString(),
  };
}

function relevance(row: Row, q: string): number {
  if (!q) return 0.5;
  const ql = q.toLowerCase();
  if ((row.slug || '').toLowerCase() === ql || (row.name || '').toLowerCase() === ql) return 1.0;
  if ((row.name || '').toLowerCase().includes(ql)) return 0.9;
  if ((row.capabilities || []).some((c) => String(c).toLowerCase().includes(ql))) return 0.75;
  if ((row.description || '').toLowerCase().includes(ql)) return 0.6;
  return 0.4;
}

// Proven first: score, then Kognai verified before outside, then AIAX ready (a tie breaker), then oldest first.
export const rank = (r: Row) => (r.origin === 'outside' ? 0 : (r.score ?? 0)) * 10 + (r.origin === 'outside' ? 0 : 1) + (r.aiax_ready ? AIAX_RANK_BOOST : 0);

// ── x402 payment header ─────────────────────────────────────────────────────
interface Payment {
  /** 1: { x402Version: 1, scheme, network, payload }; 2: { x402Version: 2, accepted, payload } (0.7.1) */
  version: 1 | 2;
  raw: Record<string, unknown>;
  from: string; nonce: string; value: string; validBefore: number;
}

function b64decode(s: string): string {
  const bin = atob(s.trim());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * The payment header: a v2 envelope { x402Version: 2, accepted, payload } (PAYMENT-SIGNATURE, or X-PAYMENT as some
 * v2 wallets send it) matched to our v2 requirement, or the v1 { x402Version: 1, scheme, network, payload } of older
 * clients. The payload is the same EIP-3009 authorization either way.
 */
export function parsePayment(header: string, nowMs: number): Payment | string {
  if (header.length > 8192) return 'the payment header is too large';
  let p: any;
  try { p = JSON.parse(b64decode(header)); } catch { return 'the payment header must be base64 JSON'; }
  let version: 1 | 2;
  if (p?.x402Version === 2) {
    version = 2;
    const acc = p?.accepted;
    if (!acc || typeof acc !== 'object') return 'an x402 v2 payment needs accepted (the requirement you picked) and payload';
    if (acc.scheme !== 'exact') return 'scheme must be exact';
    if (acc.network !== BASE_CAIP && acc.network !== 'base') return `network must be ${BASE_CAIP} (Base)`;
    const want = paymentRequirementsV2();
    if (String(acc.payTo || '').toLowerCase() !== want.payTo.toLowerCase() || String(acc.asset || '').toLowerCase() !== want.asset.toLowerCase() || String(acc.amount) !== want.amount) {
      return 'the payment does not match the accepts of this endpoint (payTo, asset, amount)';
    }
  } else if (p?.x402Version === 1) {
    version = 1;
    if (p?.scheme !== 'exact') return 'scheme must be exact';
    if (p?.network !== 'base') return 'network must be base';
  } else return 'x402Version must be 2 (or 1 for older clients)';
  const a = p?.payload?.authorization;
  const sig = p?.payload?.signature;
  if (!a || typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130,}$/.test(sig)) return 'the payment is missing the authorization or signature';
  const from = String(a.from || '');
  const to = String(a.to || '');
  const nonce = String(a.nonce || '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(from)) return 'authorization.from must be an address';
  if (to.toLowerCase() !== PAY_TO.toLowerCase()) return 'authorization.to must be the Kognai receiving wallet';
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) return 'authorization.nonce must be 32 bytes hex';
  let value: bigint;
  try { value = BigInt(String(a.value)); } catch { return 'authorization.value must be an integer'; }
  if (value !== BigInt(LISTING_FEE_ATOMIC)) return `authorization.value must be ${LISTING_FEE_ATOMIC} (0.01 USDC)`;
  const nowS = Math.floor(nowMs / 1000);
  if (!(Number(a.validBefore) > nowS + 5)) return 'the authorization has expired';
  if (Number(a.validBefore) > nowS + MAX_VALIDITY_S) return 'the authorization must expire within 1 hour (validBefore)';
  if (Number(a.validAfter) > nowS) return 'the authorization is not valid yet';
  return { version, raw: p, from: from.toLowerCase(), nonce: nonce.toLowerCase(), value: value.toString(), validBefore: Number(a.validBefore) };
}

/** What the facilitator gets: the v2 envelope with our discovery and the v2 requirement, or the v1 pair. */
export function facilitatorBody(payment: Payment): string {
  return payment.version === 2
    ? JSON.stringify({ x402Version: 2, paymentPayload: withDiscovery(payment.raw), paymentRequirements: paymentRequirementsV2() })
    : JSON.stringify({ x402Version: 1, paymentPayload: payment.raw, paymentRequirements: paymentRequirements() });
}

// ── Handler ─────────────────────────────────────────────────────────────────
function slugify(name: string, id: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
  return `ext-${base}-${id.slice(-6)}`;
}
function defaultId(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return 'lax-ext-' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
const minRate = (o: StoredOffer) => Math.min(...o.capabilities.map((c) => Number(c.pricing.amount)));

/**
 * Canonical JSON of an offer body, the input of the Content hash of an owner update:
 * object keys sorted by code point at every depth, arrays kept in order, no whitespace,
 * strings and numbers exactly as JSON.stringify writes them. sha256 of its UTF 8 bytes, lowercase hex.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map((x) => canonicalJson(x === undefined ? null : x)).join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function ownerMessage(action: 'update' | 'delist', id: string, time: string, contentHash?: string): string {
  if (action === 'update') return `LAX: update my offer\nOffer: ${id}\nContent: ${contentHash ?? '<sha256 of the canonical JSON body>'}\nTime: ${time}`;
  return `LAX: delist my offer\nOffer: ${id}\nTime: ${time}`;
}

async function readBody(req: Request): Promise<{ empty: boolean; value?: unknown; error?: string }> {
  const raw = await req.text();
  if (!raw.trim()) return { empty: true };
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return { empty: false, error: `the offer must be at most ${MAX_BODY_BYTES} bytes` };
  try { return { empty: false, value: JSON.parse(raw) }; } catch { return { empty: false, error: 'the body must be valid JSON' }; }
}

// ── Reconcile: decide rows whose settle outcome is unknown, from the chain ──
/** USDC authorizationState(address authorizer, bytes32 nonce): true once transferWithAuthorization ran. */
export const AUTH_STATE_SELECTOR = '0xe94a0102';

export async function authorizationState(f: typeof fetch, rpcUrl: string, payer: string, nonce: string): Promise<boolean> {
  const data = AUTH_STATE_SELECTOR + payer.toLowerCase().replace(/^0x/, '').padStart(64, '0') + nonce.toLowerCase().replace(/^0x/, '');
  const res = await f(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDC_BASE, data }, 'latest'] }),
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j?.error || typeof j?.result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(j.result)) {
    throw new Error('Base RPC did not answer authorizationState');
  }
  return BigInt(j.result) !== 0n;
}

export interface ReconcileOutcome { nonce: string; agent_id: string | null; result: 'listed' | 'removed' | 'still_unknown' | 'error'; detail?: string }

/**
 * For each payment whose settle outcome is unknown: if the chain shows the authorization used,
 * the payment happened, so list the row; if it is unused AND expired (it can never run now),
 * delete the row and release the nonce; if unused but still valid, leave it for later.
 */
export function createReconciler(deps: Pick<Deps, 'store' | 'fetch' | 'now' | 'rpcUrl'>) {
  const now = deps.now || (() => Date.now());
  const rpc = deps.rpcUrl || BASE_RPC_URL;
  return async function reconcile(filter: { payer?: string; nonce?: string; limit?: number } = {}): Promise<ReconcileOutcome[]> {
    const out: ReconcileOutcome[] = [];
    const pending = await deps.store.listUnknown({ ...filter, limit: filter.limit ?? 25 });
    for (const p of pending) {
      try {
        const used = await authorizationState(deps.fetch, rpc, p.payer, p.nonce);
        if (used) {
          const row = p.agent_id ? await deps.store.getAgent(p.agent_id) : null;
          if (row) {
            await deps.store.updateAgent(row.id, { listed: !row.delisted_by, settle_state: 'settled', updated_at: new Date(now()).toISOString() });
          }
          await deps.store.settleNonce(p.nonce, { agent_id: p.agent_id || '', tx_hash: null });
          out.push({ nonce: p.nonce, agent_id: p.agent_id, result: 'listed' });
        } else if (Math.floor(now() / 1000) > p.valid_before) {
          if (p.agent_id) await deps.store.deleteAgent(p.agent_id);
          await deps.store.releaseNonce(p.nonce);
          out.push({ nonce: p.nonce, agent_id: p.agent_id, result: 'removed' });
        } else {
          out.push({ nonce: p.nonce, agent_id: p.agent_id, result: 'still_unknown', detail: 'not used on chain yet and still valid' });
        }
      } catch (e) {
        out.push({ nonce: p.nonce, agent_id: p.agent_id, result: 'error', detail: String((e as Error)?.message || e).slice(0, 120) });
      }
    }
    return out;
  };
}

export function createHandler(deps: Deps) {
  const now = deps.now || (() => Date.now());
  const newId = deps.randomId || defaultId;
  const facilitator = (deps.facilitatorUrl || FACILITATOR_URL).replace(/\/+$/, '');
  const { store } = deps;
  const reconcile = createReconciler(deps);
  const aiaxFetch = deps.aiaxFetch || deps.fetch;
  /** Probe and record; never fails the caller. */
  async function markAiax(row: Row): Promise<Row> {
    try {
      const r = await probeAiax(aiaxFetch, row.endpoint || row.pact_endpoint);
      const patch = { aiax_ready: r.ready, aiax_manifest: r.manifest, aiax_checked_at: new Date(now()).toISOString() };
      await store.setAiax(row.id, patch);
      return { ...row, ...patch };
    } catch { return row; }
  }

  /**
   * Settle and classify. 'refused' only for a clear answer (success false with an errorReason);
   * a throw, a timeout or an unclear answer is 'unknown': the money may or may not have moved.
   */
  async function settlePayment(payment: Payment): Promise<{ state: 'settled' | 'refused' | 'unknown'; body?: any }> {
    let res: Response;
    try {
      res = await deps.fetch(`${facilitator}/settle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: facilitatorBody(payment),
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      return { state: 'unknown' };
    }
    const body: any = await res.json().catch(() => null);
    if (res.ok && body?.success === true) return { state: 'settled', body };
    if (body?.success === false && typeof body?.errorReason === 'string' && body.errorReason) return { state: 'refused', body };
    return { state: 'unknown', body };
  }

  async function callFacilitator(path: '/verify' | '/settle', payment: Payment): Promise<any> {
    const res = await deps.fetch(`${facilitator}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: facilitatorBody(payment),
      signal: AbortSignal.timeout(path === '/settle' ? 45_000 : 20_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`facilitator ${path} answered ${res.status}`);
    return body;
  }

  async function ownerCheck(req: Request, action: 'update' | 'delist', id: string, contentHash?: string): Promise<Row | Response> {
    const row = await store.getAgent(id);
    if (!row || row.origin !== 'outside') return json({ error: 'no outside offer with this id' }, 404);
    if (row.delisted_by === 'kognai') return json({ error: 'this offer was removed by Kognai moderation' }, 403);
    const sig = req.headers.get('x-lax-signature') || '';
    const time = req.headers.get('x-lax-time') || '';
    if (!/^0x[0-9a-fA-F]{130,}$/.test(sig) || !time) return json({ error: 'x-lax-signature and x-lax-time headers are required', message_format: ownerMessage(action, id, '<ISO time>', contentHash) }, 401);
    const t = Date.parse(time);
    if (!Number.isFinite(t) || Math.abs(now() - t) > SIG_WINDOW_MS) return json({ error: 'x-lax-time must be within 5 minutes of now' }, 401);
    if (row.owner_signed_at && t <= Date.parse(row.owner_signed_at)) return json({ error: 'this signature was already used; sign a new time' }, 401);
    let ok = false;
    try { ok = !!row.owner_address && await deps.verifyMessage({ address: row.owner_address, message: ownerMessage(action, id, time, contentHash), signature: sig }); } catch { ok = false; }
    if (!ok) {
      return json({ error: action === 'update'
        ? 'the signature does not match the owner of this offer and the Content hash of this body'
        : 'the signature does not match the owner of this offer' }, 401);
    }
    return row;
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const at = parts.lastIndexOf('lax-registry');
    const segs = at >= 0 ? parts.slice(at + 1) : (parts[0] === 'registry' ? parts.slice(1) : parts);
    const [head, id] = segs;
    if (head === 'jobs') {
      if (!deps.jobs) return json({ error: 'not found' }, 404);
      const r = await handleJobs(req, segs, { store: deps.jobs.store, adminAddress: deps.jobs.adminAddress, verifyMessage: deps.verifyMessage, now, sha256Hex, canonicalJson, scamScreen, ...(deps.randomId ? { randomId: deps.randomId } : {}),
        ...(deps.jobs.pact ? { pact: deps.jobs.pact } : {}),
        ...(deps.jobs.bids ? { bids: deps.jobs.bids, getListing: async (lid: string) => { const row = await store.getAgent(lid); return row ? { id: row.id, listed: !!row.listed, origin: row.origin, owner_address: row.owner_address, agent_did: row.agent_did } : null; } } : {}) });
      if (r) return r;
    }

    try {
      // GET /search
      if (req.method === 'GET' && head === 'search') {
        const p = url.searchParams;
        const q = (p.get('query') || '').slice(0, 100);
        const skillIds = (p.get('skill_ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
        const minAcp = Number(p.get('min_acp_score') || '0');
        const rail = p.get('payment_rail') || '';
        const origin = p.get('origin') || '';
        const limit = Math.min(Number(p.get('limit') || '20') || 20, 100);
        const offset = Number(p.get('offset') || '0') || 0;
        let rows = (await store.listListed()).filter((r) => r.listed);
        if (q) {
          const ql = q.toLowerCase();
          rows = rows.filter((r) =>
            (r.name || '').toLowerCase().includes(ql) || (r.slug || '').toLowerCase().includes(ql) ||
            (r.description || '').toLowerCase().includes(ql) ||
            (r.capabilities || []).some((c) => String(c).toLowerCase().includes(ql)));
        }
        if (skillIds.length) rows = rows.filter((r) => (r.capabilities || []).some((c) => skillIds.includes(String(c))));
        if (minAcp) rows = rows.filter((r) => r.origin !== 'outside' && (r.score ?? 0) >= minAcp);
        if (rail && !['x402', 'usdc', 'usdc-base'].includes(rail)) rows = [];
        if (origin === 'outside' || origin === 'kognai') rows = rows.filter((r) => (r.origin || 'kognai') === origin);
        const results = rows
          .map((r) => ({ offer: toOffer(r), relevance: relevance(r, q), _rank: rank(r), _t: Date.parse(r.created_at || '') || 0 }))
          .sort((a, b) => b.relevance - a.relevance || b._rank - a._rank || a._t - b._t)
          .slice(offset, offset + limit)
          .map(({ offer, relevance }) => ({ offer, relevance }));
        return json({ results, count: results.length });
      }

      // GET /offers/<id>
      if (req.method === 'GET' && head === 'offers' && id) {
        const row = await store.getAgent(id);
        if (!row || !row.listed) return json({ error: 'not found' }, 404);
        return json({ offer: toOffer(row) });
      }

      // POST /offers — paid listing
      if (req.method === 'POST' && head === 'offers' && !id) {
        const body = await readBody(req);
        // v2 wallets send PAYMENT-SIGNATURE (some also X-PAYMENT); v1 clients X-PAYMENT
        const header = req.headers.get('payment-signature') || req.headers.get('x-payment') || '';
        const askPay = 'A payment header is required: PAYMENT-SIGNATURE (x402 v2) or X-PAYMENT (x402 v1).';
        if (body.error) return json({ error: body.error }, 400);
        // an unpaid empty object (a catalog or validator probing the resource, e.g. the CDP x402 validator) learns the terms
        const emptyObject = !body.empty && body.value && typeof body.value === 'object' && !Array.isArray(body.value) && Object.keys(body.value as object).length === 0;
        if (emptyObject && !header) return paymentRequired(`${askPay} Send your offer as the JSON body; see https://lax.kognai.ai for the format.`);
        if (body.empty) {
          if (!header) return paymentRequired(`${askPay} Send your offer as the JSON body; see https://lax.kognai.ai for the format.`);
          return json({ error: 'the body must be a JSON offer object' }, 400);
        }
        let offer: StoredOffer;
        try { offer = validateOutsideOffer(body.value); } catch (e) {
          if (e instanceof Bad) return json({ error: e.message }, 400);
          throw e;
        }
        if (!header) return paymentRequired(`${askPay} Your offer is valid; pay 0.01 USDC on Base to list it.`);

        const payment = parsePayment(header, now());
        if (typeof payment === 'string') return paymentRequired(payment);

        // Decide any earlier unknown settle of this payer or this nonce first.
        try { await reconcile({ payer: payment.from }); } catch { /* chain unreachable: keep going */ }
        if (payment.nonce) { try { await reconcile({ nonce: payment.nonce }); } catch { /* same */ } }

        const dayAgo = new Date(now() - 86_400_000).toISOString();
        if (await store.countPayments(dayAgo, payment.from) >= PER_PAYER_DAILY) {
          return json({ error: `at most ${PER_PAYER_DAILY} listings per payer per day` }, 429);
        }
        if (await store.countPayments(dayAgo) >= GLOBAL_DAILY) {
          return json({ error: 'the registry is taking no more new listings today; try tomorrow' }, 429);
        }
        if (!(await store.claimNonce({ nonce: payment.nonce, payer: payment.from, amount_atomic: payment.value, valid_before: payment.validBefore }))) {
          const stillOpen = (await store.listUnknown({ nonce: payment.nonce, limit: 1 })).length > 0;
          return json({ error: stillOpen
            ? 'this payment is being checked on chain; the listing appears once it is confirmed'
            : 'this payment authorization was already used' }, 409);
        }

        // 1. verify with the facilitator
        let verification: any;
        try { verification = await callFacilitator('/verify', payment); } catch (e) {
          await store.releaseNonce(payment.nonce);
          return paymentRequired(`payment could not be verified: ${(e as Error).message}`);
        }
        if (verification?.isValid !== true) {
          await store.releaseNonce(payment.nonce);
          return paymentRequired(`payment rejected: ${String(verification?.invalidReason || 'invalid payment').slice(0, 120)}`);
        }

        // 2. insert the listing
        const agentId = newId();
        const iso = new Date(now()).toISOString();
        const row: Row = {
          id: agentId, name: offer.name, slug: slugify(offer.name, agentId), description: offer.description,
          score: 0, capabilities: offer.capabilities.map((c) => c.skill_id), category: offer.category || 'Outside agent',
          rate_usdc: minRate(offer), listed: true, origin: 'outside', verified: false, builder: 'outside',
          owner_address: payment.from, payer: payment.from, endpoint: offer.endpoint, pact_endpoint: offer.pact_endpoint,
          agent_did: offer.agent_did, offer, updated_at: iso, settle_state: 'pending',
        };
        try { await store.insertAgent(row); } catch (e) {
          await store.releaseNonce(payment.nonce);
          throw e;
        }

        // 3. settle. A clear refusal removes the row; an unknown outcome keeps it unlisted
        //    with the nonce claimed until reconcile reads the chain.
        const outcome = await settlePayment(payment);
        if (outcome.state === 'refused') {
          await store.deleteAgent(agentId);
          await store.releaseNonce(payment.nonce);
          return paymentRequired(`payment could not be settled: ${String(outcome.body.errorReason).slice(0, 120)}; nothing was listed`);
        }
        if (outcome.state === 'unknown') {
          await store.updateAgent(agentId, { listed: false, settle_state: 'unknown' });
          await store.markUnknown(payment.nonce, agentId);
          return json({
            ok: false, id: agentId, settle_state: 'unknown',
            note: 'The payment outcome is not known yet. The offer is saved but not listed; it is listed once the chain shows the payment, or removed if the authorization expires unused. Send any new request with this wallet, or wait, to check again.',
          }, 202);
        }
        const settle = outcome.body;
        await store.updateAgent(agentId, { settle_state: 'settled' });
        await store.settleNonce(payment.nonce, { agent_id: agentId, tx_hash: settle.transaction || null });
        const listedRow = await markAiax(row);
        // the receipt: X-PAYMENT-RESPONSE (v1 readers) and PAYMENT-RESPONSE (v2, CAIP network) on every paid answer
        const receipt = { success: true, transaction: settle.transaction || null, network: settle.network || 'base', payer: settle.payer || payment.from };
        return json(
          { ok: true, id: agentId, offer: toOffer(listedRow), transaction: settle.transaction || null,
            note: 'Listed as unproven, not verified by Kognai. Update or delist for free by signing with the paying wallet.' },
          201,
          { 'X-PAYMENT-RESPONSE': b64encode(JSON.stringify(settle)), 'PAYMENT-RESPONSE': b64encode(JSON.stringify({ ...receipt, network: receipt.network === 'base' ? BASE_CAIP : receipt.network })) },
        );
      }

      // PUT /offers/<id> — owner update
      if (req.method === 'PUT' && head === 'offers' && id) {
        const body = await readBody(req);
        if (body.error) return json({ error: body.error }, 400);
        let offer: StoredOffer;
        try { offer = validateOutsideOffer(body.value); } catch (e) {
          if (e instanceof Bad) return json({ error: e.message }, 400);
          throw e;
        }
        const contentHash = await sha256Hex(canonicalJson(body.value));
        const row = await ownerCheck(req, 'update', id, contentHash);
        if (row instanceof Response) return row;
        const iso = new Date(now()).toISOString();
        const patch: Partial<Row> = {
          name: offer.name, description: offer.description, category: offer.category || 'Outside agent',
          capabilities: offer.capabilities.map((c) => c.skill_id), rate_usdc: minRate(offer),
          endpoint: offer.endpoint, pact_endpoint: offer.pact_endpoint, agent_did: offer.agent_did, offer,
          updated_at: iso, owner_signed_at: new Date(Date.parse(req.headers.get('x-lax-time')!)).toISOString(),
        };
        await store.updateAgent(id, patch);
        const updated = await markAiax({ ...row, ...patch });
        return json({ ok: true, id, offer: toOffer(updated) });
      }

      // DELETE /offers/<id> — owner delist
      if (req.method === 'DELETE' && head === 'offers' && id) {
        const row = await ownerCheck(req, 'delist', id);
        if (row instanceof Response) return row;
        await store.updateAgent(id, {
          listed: false, delisted_by: 'owner', delisted_reason: 'delisted by its owner',
          updated_at: new Date(now()).toISOString(),
          owner_signed_at: new Date(Date.parse(req.headers.get('x-lax-time')!)).toISOString(),
        });
        return json({ ok: true, id, listed: false });
      }

      // POST /reconcile: decide unknown settles from the chain (idempotent, reads only the chain).
      if (req.method === 'POST' && head === 'reconcile' && !id) {
        const results = await reconcile({ limit: 25 });
        return json({ ok: true, results });
      }

      // POST /aiax-check: probe up to 10 listed rows not checked in the last 24 hours (idempotent, public reads only).
      if (req.method === 'POST' && head === 'aiax-check' && !id) {
        const due = await store.listAiaxDue(new Date(now() - AIAX_RECHECK_MS).toISOString(), 10);
        const results: Array<{ id: string; ready: boolean; manifest: string | null }> = [];
        for (const r of due) {
          const m = await markAiax(r);
          results.push({ id: r.id, ready: !!m.aiax_ready, manifest: m.aiax_manifest ?? null });
        }
        return json({ ok: true, results });
      }

      if (req.method === 'GET' && !head) {
        return json({
          name: 'LAX Registry', version: VERSION,
          endpoints: ['GET /search', 'GET /offers/<id>', 'POST /offers (x402 v2, 0.01 USDC on Base; v1 X-PAYMENT still accepted)', 'PUT /offers/<id> (owner signed, content bound)', 'DELETE /offers/<id> (owner signed)', 'POST /reconcile', 'POST /aiax-check',
            'GET /jobs', 'GET /jobs/<id>', 'POST /jobs/<id>/bids (listing owner signed)', 'GET|POST /jobs/<id>/pact (selected agent, listing owner signed)', 'GET|POST /jobs/<id>/delivery (selected agent, listing owner signed)'],
          aiax: { manifest: AIAX_MANIFEST_URL, ready_badge: 'An offer whose base URL serves a valid AIAX v0.1 manifest (/aiax/manifest.json or /.well-known/aiax.json) shows the AIAX ready badge and gets a small ranking boost; rechecked every 24 hours.' },
          listing_fee: { amount: '0.01', currency: 'USDC', network: 'base', payTo: PAY_TO },
          note: 'Linked Agent eXchange discovery registry. Outside listings are unproven and not verified by Kognai. Kognai never asks for keys or seed phrases.',
        });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'internal error', detail: String((e as Error)?.message || e).slice(0, 200) }, 500);
    }
  };
}
