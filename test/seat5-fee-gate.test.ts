import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHarness } from '../src/load.ts';
const body = async (res: Response): Promise<any> => res.clone().json();
async function offerQuote(h: any, agent: any) { const res = await h.handle(h.offerRequest({ agent })); assert.equal(res.status, 402); return { res, quote: await h.quoteOf(res) }; }
async function bidQuote(h: any, agent: any, jobId: string, offerId: string) { const res = await h.handle(await h.bidRequest({ agent, jobId, offerId })); assert.equal(res.status, 402); return { res, quote: await h.quoteOf(res) }; }
test('offers: no fee refused', async () => { const { createHarness } = await loadHarness(); const h = createHarness(); const { quote } = await offerQuote(h, h.agents[0]); assert.equal(h.stores.store.agents.size,0); });
test('bids: no fee refused', async () => { const { createHarness } = await loadHarness(); const h = createHarness(); const b=h.agents[1]; const j=h.seedJob(); const o=h.seedListing(b); const { quote } = await bidQuote(h,b,j,o); assert.equal(h.stores.bidStore.bids.size,0); });
test('offers short', async () => { const { createHarness } = await loadHarness(); const h = createHarness(); const a=h.agents[0]; const {quote}=await offerQuote(h,a); const fee=h.payKog({quote,amount:String(BigInt(quote.amount)-1n)}); assert.equal((await h.handle(h.offerRequest({agent:a,quote,fee}))).status,402); assert.equal(h.stores.store.agents.size,0); });
test('bids short', async () => { const { createHarness } = await loadHarness(); const h = createHarness(); const b=h.agents[1]; const j=h.seedJob(); const o=h.seedListing(b); const {quote}=await bidQuote(h,b,j,o); const fee=h.payKog({quote,amount:'1'}); assert.equal((await h.handle(await h.bidRequest({agent:b,jobId:j,offerId:o,quote,fee}))).status,402); assert.equal(h.stores.bidStore.bids.size,0); });
test('offers valid then reuse 409', async () => { const { createHarness } = await loadHarness(); const h = createHarness(); const a=h.agents[0]; const {quote}=await offerQuote(h,a); const fee=h.payKog({quote}); assert.equal((await h.handle(h.offerRequest({agent:a,quote,fee}))).status,201); assert.equal(h.stores.store.agents.size,1); const b=h.agents[1]; const {quote:q2}=await offerQuote(h,b); assert.equal((await h.handle(h.offerRequest({agent:b,quote:q2,fee}))).status,409); assert.equal(h.stores.store.agents.size,1); });
test('bids valid then reuse 409', async () => { const { createHarness } = await loadHarness(); const h = createHarness(); const b=h.agents[1]; const j=h.seedJob(); const o=h.seedListing(b); const {quote}=await bidQuote(h,b,j,o); const fee=h.payKog({quote}); assert.equal((await h.handle(await h.bidRequest({agent:b,jobId:j,offerId:o,quote,fee}))).status,201); assert.equal(h.stores.bidStore.bids.size,1); const j2=h.seedJob(); const {quote:q2}=await bidQuote(h,b,j2,o); assert.equal((await h.handle(await h.bidRequest({agent:b,jobId:j2,offerId:o,quote:q2,fee}))).status,409); assert.equal(h.stores.bidStore.bids.size,1); });
test('refused not spent', async () => { const { createHarness } = await loadHarness(); const h = createHarness(); const a=h.agents[0]; const {quote}=await offerQuote(h,a); const fee=h.payKog({quote}); assert.equal((await h.handle(h.offerRequest({agent:a,quote,fee,body:{name:'x'}}))).status,400); assert.equal((await h.handle(h.offerRequest({agent:a,quote,fee}))).status,201); });
test('cross route', async () => { const { createHarness } = await loadHarness(); const h = createHarness(); const b=h.agents[2]; const j=h.seedJob(); const o=h.seedListing(b); const {quote:oq}=await offerQuote(h,b); assert.equal((await h.handle(await h.bidRequest({agent:b,jobId:j,offerId:o,quote:oq,fee:h.payKog({quote:oq})}))).status,402); });
test('a payment stamped after the quote expired is refused, and nothing is spent', async () => {
  const { createHarness } = await loadHarness();
  const { checkPayment } = await import('../src/kog-fee.ts');
  const h = createHarness(); const a = h.agents[0];
  const { quote } = await offerQuote(h, a);
  // The gate's clock can lag the chain by a few seconds: the quote has not expired by the gate's clock, but the
  // payment's block_time is after expires_at. Such a payment must not buy a listing.
  const at = Date.parse(quote.expires_at) + 2_000;
  h.clock.now = Date.parse(quote.expires_at) - 5_000;
  const late = h.payKog({ quote, at });
  const verdict = checkPayment({ payment: h.chain.get(late)!, quote, seen: h.used, now: h.clock.now });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'paid after the quote expired');
  assert.equal((await h.handle(h.offerRequest({ agent: a, quote, fee: late }))).status, 402);
  assert.equal(h.stores.store.agents.size, 0, 'nothing was listed');
  assert.equal(h.used.has(late), false, 'the refused payment was not spent');
  // The same quote still works with a payment inside the window; the refusal cost the agent nothing.
  assert.equal((await h.handle(h.offerRequest({ agent: a, quote, fee: h.payKog({ quote }) }))).status, 201);
  assert.equal(h.stores.store.agents.size, 1);
});
