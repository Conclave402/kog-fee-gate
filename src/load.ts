/**
 * loadHarness(): the one door a test suite uses to get the harness. With LAX_HARNESS set (the path of a module that
 * exports createHarness), it loads that module: this is how Kognai runs the same suite against its production fee
 * gate, and how the review runs it against broken gates. Unset, it loads this kit's harness.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createHarness as CreateHarness } from './harness.ts';

export async function loadHarness(): Promise<{ createHarness: typeof CreateHarness }> {
  const path = process.env.LAX_HARNESS;
  const m: any = path ? await import(pathToFileURL(resolve(path)).href) : await import('./harness.ts');
  if (typeof m.createHarness !== 'function') throw new Error(`${path || 'the harness'} does not export createHarness`);
  return { createHarness: m.createHarness };
}
