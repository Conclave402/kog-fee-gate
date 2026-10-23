/** Tests of the kit itself: the gate's answers on both routes, the fee spent only on success, the loader. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../src/harness.ts';
import { checkPayment, gatedRoute } from '../src/kog-fee.ts';
import { loadHarness } from '../src/load.ts';

const status = async (r: Promise<Response> | Response) => (await r).status;

test('offers: no fee 402 with a quote; short, wrong mint, wrong payee, unknown quote, expired 402; valid 201; reused 409', async () => {
  const h = createHarness(); const a = h.agents[0];
  const r0 = await h.handle(h.offerRequest({ agent: a }));
  assert.equal(r0.status, 402); const q = await h.quoteOf(r0);
  assert.deepEqual([q.route, q.amount, q.mint, q.payee], ['POST /offers', h.kog.fees.offer, h.kog.mint, h.kog.payee]);
  assert.equal(await status(h.handle(h.offerRequest({ agent: a, quote: q, fee: h.payKog({ quote: q, amount: '999999' }) }))), 402);
  assert.equal(await status(h.handle(h.offerRequest({ agent: a, quote: q, fee: h.payKog({ quote: q, mint: 'WrongMint1111111111111111111111111111111111' }) }))), 402);
  assert.equal(await status(h.handle(h.offerRequest({ agent: a, quote: q, fee: h.payKog({ quote: q, payee: 'Somebody111111111111111111111111111111111' }) }))), 402);
  assert.equal(await status(h.handle(h.offerRequest({ agent: a, quote: q, fee: h.payKog({ quote: q, ok: false }) }))), 402);
  assert.equal(await status(h.handle(h.offerRequest({ agent: a, quote: 'kq-none', fee: h.payKog({ quote: q }) }))), 402);
  assert.equal(await status(h.handle(h.offerRequest({ agent: a, quote: q, fee: 'NotOnChain111' }))), 402);
  const fee = h.payKog({ quote: q });
  const ok = await h.handle(h.offerRequest({ agent: a, quote: q, fee })); assert.equal(ok.status, 201, await ok.clone().text());
  assert.equal(h.stores.store.agents.size, 1);
  const q2 = await h.quoteOf(await h.handle(h.offerRequest({ agent: h.agents[1] })));
  const again = await h.handle(h.offerRequest({ agent: h.agents[1], quote: q2, fee })); assert.equal(again.status, 409);
  const late = createHarness(); const lq = await late.quoteOf(await late.handle(late.offerRequest({ agent: a })));
  const lf = late.payKog({ quote: lq }); late.clock.now += 11 * 60_000;
  assert.equal(await status(late.handle(late.offerRequest({ agent: a, quote: lq, fee: lf }))), 402, 'an expired quote');
  assert.equal(await status(late.handle(late.offerRequest({ agent: a, quote: lq, fee: late.payKog({ quote: lq, at: Date.parse(lq.expires_at) + 1 }) }))), 402);
});

test('offers: a fee is spent only when the registry accepts the request; a quote is for one route', async () => {
  const h = createHarness(); const a = h.agents[0];
  const q = await h.quoteOf(await h.handle(h.offerRequest({ agent: a })));
  const fee = h.payKog({ quote: q });
  assert.equal(await status(h.handle(h.offerRequest({ agent: a, quote: q, fee, body: { name: 'x' } }))), 400, 'an invalid offer is refused by the registry');
  assert.equal(await status(h.handle(h.offerRequest({ agent: a, quote: q, fee }))), 201, 'the fee was not spent by the refused request');
  const jobId = h.seedJob(); const offerId = h.seedListing(h.agents[2]);
  const oq = await h.quoteOf(await h.handle(h.offerRequest({ agent: a })));
  assert.equal(await status(h.handle(await h.bidRequest({ agent: h.agents[2], jobId, offerId, quote: oq, fee: h.payKog({ quote: oq }) }))), 402, 'an offers quote does not pay a bid');
});

test('bids: no fee 402, short 402, valid 201, reused 409; the bid fee is lower than the listing fee', async () => {
  const h = createHarness(); const a = h.agents[1]; const jobId = h.seedJob(); const offerId = h.seedListing(a);
  const r0 = await h.handle(await h.bidRequest({ agent: a, jobId, offerId })); assert.equal(r0.status, 402);
  const q = await h.quoteOf(r0); assert.equal(q.route, `POST /jobs/${jobId}/bids`); assert.equal(q.amount, h.kog.fees.bid);
  assert.equal(await status(h.handle(await h.bidRequest({ agent: a, jobId, offerId, quote: q, fee: h.payKog({ quote: q, amount: '1' }) }))), 402);
  const fee = h.payKog({ quote: q });
  assert.equal(await status(h.handle(await h.bidRequest({ agent: a, jobId, offerId, quote: q, fee }))), 201);
  const job2 = h.seedJob(); const q2 = await h.quoteOf(await h.handle(await h.bidRequest({ agent: a, jobId: job2, offerId })));
  assert.equal(await status(h.handle(await h.bidRequest({ agent: a, jobId: job2, offerId, quote: q2, fee }))), 409);
  assert.ok(BigInt(h.kog.fees.bid) < BigInt(h.kog.fees.offer));
});

test('the gate leaves other routes alone; the route parser; the payment check', async () => {
  const h = createHarness();
  assert.equal(await status(h.handle(new Request(`${h.base}/search`))), 200);
  assert.equal(gatedRoute(new Request('https://x/functions/v1/lax-registry/offers', { method: 'POST' }))?.route, 'POST /offers');
  assert.equal(gatedRoute(new Request('https://x/registry/jobs/j1/bids', { method: 'POST' }))?.route, 'POST /jobs/j1/bids');
  assert.equal(gatedRoute(new Request('https://x/registry/jobs/j1/pact', { method: 'POST' })), null);
  assert.equal(gatedRoute(new Request('https://x/registry/offers', { method: 'PUT' })), null);
  const q = { quote_id: 'q', route: 'POST /offers', amount: '10', mint: 'M', payee: 'P', expires_at: '2026-10-22T12:10:00.000Z' };
  const p = { signature: 's', mint: 'M', payee: 'P', amount: '10', from: 'F', block_time: '2026-10-22T12:00:00.000Z', ok: true };
  const seen = new Set<string>(); const now = Date.parse('2026-10-22T12:01:00Z');
  assert.equal(checkPayment({ payment: p, quote: q, seen, now }).ok, true);
  assert.equal(checkPayment({ payment: { ...p, amount: 'ten' }, quote: q, seen, now }).ok, false);
  assert.equal(checkPayment({ payment: p, quote: q, seen: new Set(['s']), now }).ok, false);
  assert.equal(checkPayment({ payment: null as any, quote: q, seen, now }).ok, false);
});

test('options: gated routes, an injected verifier and fee store; loadHarness honours LAX_HARNESS', async () => {
  const open = createHarness({ gated: ['bids'] }); assert.equal(await status(open.handle(open.offerRequest({ agent: open.agents[0] }))), 201);
  const lax = createHarness({ verify: () => ({ ok: true, reason: 'any' }) }); const q = await lax.quoteOf(await lax.handle(lax.offerRequest({ agent: lax.agents[0] })));
  assert.equal(await status(lax.handle(lax.offerRequest({ agent: lax.agents[0], quote: q, fee: lax.payKog({ quote: q, amount: '1' }) }))), 201);
  const dir = mkdtempSync(join(tmpdir(), 'kit-harness-'));
  const hp = fileURLToPath(new URL('../src/harness.ts', import.meta.url));
  try {
    writeFileSync(join(dir, 'open.mts'), `import * as H from ${JSON.stringify(hp)};\nexport const createHarness = (o = {}) => H.createHarness({ ...o, gated: [] });\n`);
    writeFileSync(join(dir, 'none.mts'), 'export const x = 1;\n');
    process.env.LAX_HARNESS = join(dir, 'open.mts');
    const { createHarness: c } = await loadHarness(); const h = c();
    assert.equal(await status(h.handle(h.offerRequest({ agent: h.agents[0] }))), 201);
    process.env.LAX_HARNESS = join(dir, 'none.mts'); await assert.rejects(loadHarness(), /does not export createHarness/);
  } finally { delete process.env.LAX_HARNESS; rmSync(dir, { recursive: true, force: true }); }
});
