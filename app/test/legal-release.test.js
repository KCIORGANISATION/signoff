// Release guard: the legal pages must not go public with empty values.
// It runs where the deployment's settings are known: BETA_MODE is set (to anything), or
// NODE_ENV is production. With BETA_MODE off, every value of src/legal-config.js must be
// filled in, else this test fails. A plain local "npm test" without BETA_MODE skips it.
// Before leaving the beta: BETA_MODE=false npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const decides = process.env.BETA_MODE !== undefined || process.env.NODE_ENV === 'production';

test('with BETA_MODE off, no legal value is left empty', { skip: decides ? false : 'BETA_MODE is not set: run "BETA_MODE=false npm test" before leaving the beta' }, async () => {
  const { config } = await import('../src/config.js');
  const { legalGaps } = await import('../src/legal-config.js');
  if (config.beta.enabled) return;
  assert.deepEqual(legalGaps(), [], 'fill these in src/legal-config.js before turning BETA_MODE off');
});
