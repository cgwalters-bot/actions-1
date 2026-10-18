import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function probe(request = fetch, env = process.env) {
  // Node fetch must use transparent interception and the exported per-job CA,
  // not explicit proxy settings. Each request has its own finite deadline.
  assert.ok(!env.NODE_USE_ENV_PROXY, 'NODE_USE_ENV_PROXY must be unset');
  for (const method of ['GET', 'POST']) {
    const response = await request('https://example.com/', {
      method, redirect: 'error', signal: AbortSignal.timeout(15000),
      ...(method === 'POST' ? { body: 'probe' } : {}),
    });
    await response.body?.cancel();
    assert.equal(response.status, method === 'GET' ? 200 : 403);
    if (method === 'POST') {
      assert.match(response.headers.get('x-egress-denied') || '', /not in the write allowlist/);
    }
    console.log(`${method}: ${method === 'GET' ? 'allowed' : 'refused by proxy'}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await probe();
}
