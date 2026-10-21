import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from './check.mjs';

const env = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token?existing=1',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
  AUDIENCE: 'test-audience', OAUTH_CLIENT_ID: 'test-client',
  PROXY: 'http://proxy.example:18080',
};

test('check reports scopes, never tokens, and expects a proxy 401', async t => {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  let calls = 0;
  await check(env, async (url, options) => {
    calls++;
    if (calls === 1) {
      assert.equal(url.searchParams.get('audience'), env.AUDIENCE);
      assert.equal(options.headers.Authorization, 'Bearer request-token');
      return Response.json({ value: 'oidc-token' });
    }
    if (calls === 2) {
      assert.equal(url, 'https://api.tailscale.com/api/v2/oauth/token-exchange');
      assert.equal(options.body.get('client_id'), env.OAUTH_CLIENT_ID);
      assert.equal(options.body.get('jwt'), 'oidc-token');
      return Response.json({ scope: 'auth_keys', access_token: 'access-token' });
    }
    assert.equal(url.href, 'http://proxy.example:18080/v1/runs');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers, undefined);
    assert.equal(options.redirect, 'error');
    return new Response(null, { status: 401 });
  });
  assert.equal(calls, 3);
  assert.deepEqual(lines, ['Granted scopes: auth_keys',
    'Proxy returned the expected unauthenticated HTTP 401']);
});

test('check rejects failed exchanges, missing fields and unexpected proxy responses', async t => {
  t.mock.method(console, 'log', () => {});
  const cases = [
    [[new Response(null, { status: 403 })], /HTTP 403/],
    [[Response.json({})], /did not include a token/],
    [[Response.json({ value: 'oidc-token' }), new Response(null, { status: 401 })], /HTTP 401/],
    [[Response.json({ value: 'oidc-token' }), Response.json({})], /granted scopes/],
    [[Response.json({ value: 'oidc-token' }), Response.json({ scope: 'auth_keys' }),
      new Response(null, { status: 200 })], /expected 401/],
  ];
  for (const [responses, error] of cases) {
    await assert.rejects(check(env, async () => responses.shift()), error);
  }
  await assert.rejects(check({ ...env, PROXY: '' }, async () => assert.fail('no request')), /needs the proxy input/);
});
