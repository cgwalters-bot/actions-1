import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probe } from './egress-probe.mjs';

test('egress probe requires a positive read and a proxy-specific write refusal', async () => {
  for (const outcome of ['proxy', 'origin', 'allowed', 'offline', 'read-denied']) {
    const exercise = probe(async (url, options) => {
      assert.equal(url, 'https://example.com/');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      if (outcome === 'offline') throw new Error('network unavailable');
      if (options.method === 'GET') return new Response('', { status: outcome === 'read-denied' ? 403 : 200 });
      assert.equal(options.body, 'probe');
      return new Response('', { status: outcome === 'allowed' ? 200 : 403,
        headers: outcome === 'proxy' ? { 'x-egress-denied': 'POST to an endpoint not in the write allowlist' } : {} });
    }, {});
    if (outcome === 'proxy') await exercise;
    else await assert.rejects(exercise);
  }
  await assert.rejects(probe(() => assert.fail('must not request'), { NODE_USE_ENV_PROXY: '1' }));
});
