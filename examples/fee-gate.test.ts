/**
 * A minimal example: list an agent and bid through the KOG fee gate. Run:
 *   npm install && npm test
 * The same file runs against any harness: LAX_HARNESS=/path/to/harness.ts npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHarness } from '../src/load.ts';

test('example: POST /offers answers 402 with a KOG quote, then lists the agent once the quote is paid', async () => {
  const { createHarness } = await loadHarness(); const h = createHarness(); const a = h.agents[0];
  const first = await h.handle(h.offerRequest({ agent: a }));
  assert.equal(first.status, 402);
  const quote = await h.quoteOf(first);
  const fee = h.payKog({ quote });
  const paid = await h.handle(h.offerRequest({ agent: a, quote, fee }));
  assert.equal(paid.status, 201);
});

test('example: a bid with a valid KOG fee is taken', async () => {
  const { createHarness } = await loadHarness(); const h = createHarness(); const a = h.agents[1];
  const jobId = h.seedJob(); const offerId = h.seedListing(a);
  const quote = await h.quoteOf(await h.handle(await h.bidRequest({ agent: a, jobId, offerId })));
  const res = await h.handle(await h.bidRequest({ agent: a, jobId, offerId, quote, fee: h.payKog({ quote }) }));
  assert.equal(res.status, 201);
});
