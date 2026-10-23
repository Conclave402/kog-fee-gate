/**
 * The KOG fee gate, harness version 1: every Kognai fee is paid in KOG on Solana (the LAX listing fee and the tender
 * bid fee). The gate sits in front of the registry handler on POST /offers and POST /jobs/<id>/bids.
 *
 *   1. No x-kog-fee header: 402 { error, kog_fee: <quote> }. The quote: { quote_id, route, amount (atomic units, KOG has
 *      6 decimals), mint, payee (the owner wallet), expires_at (10 minutes) }.
 *   2. The agent pays the quote on Solana and sends the request again with x-kog-quote: <quote_id> and
 *      x-kog-fee: <the transaction signature>.
 *   3. Unknown quote, a quote for another route, a transaction not found, or a payment the verifier refuses (short,
 *      wrong mint, wrong payee, expired quote, failed transaction): 402 with the reason and a fresh quote.
 *      A signature already used for an accepted request: 409.
 *   4. Otherwise the request goes to the registry; the fee is spent only when the registry accepts it (2xx).
 *
 * In this harness the chain is a map of payment records (KogPayment) and the verifier is a plain record check. In
 * production the chain is Solana RPC and the verifier is verifyKogFee over the parsed transaction (seat SEAT4); the
 * gate's answers stay the same.
 */
export const KOG_DECIMALS = 6;
/** Harness values only, not the live prices. */
export const KOG_FEES = { offer: '1000000', bid: '500000' } as const;
export const KOG_MINT = 'KoGFeeTestMint11111111111111111111111111111';
export const KOG_PAYEE = 'KognaiFeeTestWa11et1111111111111111111111';
export const QUOTE_TTL_MS = 10 * 60_000;

export type GatedRoute = 'offers' | 'bids';
export interface KogQuote { quote_id: string; route: string; amount: string; mint: string; payee: string; expires_at: string }
/** A KOG payment as the harness chain records it (what a parsed Token 2022 transfer proves). */
export interface KogPayment { signature: string; mint: string; payee: string; amount: string; from: string; block_time: string; ok: boolean }
export interface Verdict { ok: boolean; reason: string }
export type Verify = (a: { payment: KogPayment; quote: KogQuote; seen: { has(sig: string): boolean }; now: number }) => Verdict;
/** Fees already spent: claim is false when the signature was already claimed. */
export interface UsedFees { has(sig: string): boolean; claim(sig: string): boolean; release(sig: string): void }

export const usedFees = (): UsedFees & { all: Set<string> } => {
  const all = new Set<string>();
  return { all, has: (s) => all.has(s), claim: (s) => (all.has(s) ? false : (all.add(s), true)), release: (s) => { all.delete(s); } };
};

/** The harness verifier: the payment succeeded, on the quoted mint, to the quoted payee, at or above the amount, in time, not seen. */
export const checkPayment: Verify = ({ payment: p, quote: q, seen, now }) => {
  if (!p || p.ok !== true) return { ok: false, reason: 'the transaction failed or is missing' };
  if (p.mint !== q.mint) return { ok: false, reason: 'wrong mint' };
  if (p.payee !== q.payee) return { ok: false, reason: 'wrong payee' };
  if (!(now < Date.parse(q.expires_at))) return { ok: false, reason: 'the quote expired' };
  if (Date.parse(p.block_time) > Date.parse(q.expires_at)) return { ok: false, reason: 'paid after the quote expired' };
  if (seen.has(p.signature)) return { ok: false, reason: 'this fee was already used' };
  let paid: bigint; try { paid = BigInt(p.amount); } catch { return { ok: false, reason: 'the amount is not an integer' }; }
  if (paid < BigInt(q.amount)) return { ok: false, reason: `short fee: ${p.amount} paid, ${q.amount} due` };
  return { ok: true, reason: 'paid' };
};

const reply = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Which gated route a request is, and its route string; null when the gate lets it through untouched. */
export function gatedRoute(req: Request): { kind: GatedRoute; route: string } | null {
  if (req.method !== 'POST') return null;
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const at = parts.lastIndexOf('lax-registry');
  const segs = at >= 0 ? parts.slice(at + 1) : parts[0] === 'registry' ? parts.slice(1) : parts;
  if (segs[0] === 'offers' && segs.length === 1) return { kind: 'offers', route: 'POST /offers' };
  if (segs[0] === 'jobs' && segs.length === 3 && segs[2] === 'bids') return { kind: 'bids', route: `POST /jobs/${segs[1]}/bids` };
  return null;
}

export interface GateOptions {
  now: () => number; newId: () => string;
  chain: Map<string, KogPayment>; quotes: Map<string, KogQuote>; used: UsedFees; verify: Verify;
  gated: GatedRoute[]; fees: { offer: string; bid: string }; mint: string; payee: string;
}

export function kogFeeGate(inner: (req: Request) => Promise<Response>, o: GateOptions): (req: Request) => Promise<Response> {
  const quote = (route: string, kind: GatedRoute): KogQuote => {
    const q: KogQuote = { quote_id: `kq-${o.newId()}`, route, amount: kind === 'offers' ? o.fees.offer : o.fees.bid, mint: o.mint, payee: o.payee, expires_at: new Date(o.now() + QUOTE_TTL_MS).toISOString() };
    o.quotes.set(q.quote_id, q); return q;
  };
  return async (req: Request) => {
    const g = gatedRoute(req); if (!g || !o.gated.includes(g.kind)) return inner(req);
    const fee = (req.headers.get('x-kog-fee') || '').trim(); const qid = (req.headers.get('x-kog-quote') || '').trim();
    if (!fee) return reply({ error: 'a KOG fee is required: pay the quote in KOG on Solana, then send x-kog-quote and x-kog-fee (the transaction signature)', kog_fee: quote(g.route, g.kind) }, 402);
    const q = o.quotes.get(qid);
    if (!q || q.route !== g.route) return reply({ error: 'unknown quote for this route: ask again without x-kog-fee', kog_fee: quote(g.route, g.kind) }, 402);
    if (o.used.has(fee)) return reply({ error: 'this KOG fee was already used' }, 409);
    const p = o.chain.get(fee);
    if (!p) return reply({ error: 'the fee transaction was not found on chain', kog_fee: quote(g.route, g.kind) }, 402);
    const v = o.verify({ payment: p, quote: q, seen: o.used, now: o.now() });
    if (!v.ok) return reply({ error: `the KOG fee was refused: ${v.reason}`, kog_fee: quote(g.route, g.kind) }, 402);
    if (!o.used.claim(fee)) return reply({ error: 'this KOG fee was already used' }, 409);
    let res: Response;
    try { res = await inner(req); } catch (e) { o.used.release(fee); throw e; }
    if (res.status >= 200 && res.status < 300) o.quotes.delete(q.quote_id); else o.used.release(fee);
    return res;
  };
}
