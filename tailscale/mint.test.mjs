import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEY_EXPIRY_SECONDS, mint } from './mint.mjs';

const env = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token?existing=1',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
  AUDIENCE: 'test-audience', OAUTH_CLIENT_ID: 'test-client',
  TAGS: 'tag:one, tag:two',
};

test('mint exchanges the identity token and asks for a single-use ephemeral key', async () => {
  const calls = [];
  const key = await mint(env, async (url, options) => {
    calls.push(String(url));
    if (calls.length === 1) {
      assert.equal(url.searchParams.get('audience'), env.AUDIENCE);
      assert.equal(url.searchParams.get('existing'), '1');
      assert.equal(options.headers.Authorization, 'Bearer request-token');
      return Response.json({ value: 'oidc-token' });
    }
    if (calls.length === 2) {
      assert.equal(options.method, 'POST');
      assert.equal(options.body.get('client_id'), env.OAUTH_CLIENT_ID);
      assert.equal(options.body.get('jwt'), 'oidc-token');
      return Response.json({ scope: 'auth_keys', access_token: 'access-token' });
    }
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer access-token');
    assert.deepEqual(JSON.parse(options.body), {
      capabilities: { devices: { create: {
        reusable: false, ephemeral: true, preauthorized: true, tags: ['tag:one', 'tag:two'],
      } } },
      expirySeconds: KEY_EXPIRY_SECONDS,
    });
    return Response.json({ key: 'tskey-auth-abc123-DEF' });
  });
  assert.equal(key, 'tskey-auth-abc123-DEF');
  assert.deepEqual(calls.slice(1), [
    'https://api.tailscale.com/api/v2/oauth/token-exchange',
    'https://api.tailscale.com/api/v2/tailnet/-/keys',
  ]);
  assert.equal(KEY_EXPIRY_SECONDS, 3600);
});

test('mint refuses debug logging, missing tags, failures and malformed keys', async () => {
  const unreachable = async () => assert.fail('no request expected');
  await assert.rejects(mint({ ...env, RUNNER_DEBUG: '1' }, unreachable), /debug logging/);
  await assert.rejects(mint({ ...env, TAGS: ' , ' }, unreachable), /tags/);
  const oidc = () => Response.json({ value: 'oidc-token' });
  const access = () => Response.json({ access_token: 'access-token' });
  const cases = [
    [[new Response(null, { status: 403 })], /Identity request failed: HTTP 403/],
    [[Response.json({})], /did not include a token/],
    [[oidc(), new Response(null, { status: 401 })], /Token exchange failed: HTTP 401/],
    [[oidc(), Response.json({ scope: 'auth_keys' })], /access token/],
    [[oidc(), access(), new Response(null, { status: 403 })], /Key creation failed: HTTP 403/],
    [[oidc(), access(), Response.json({})], /no auth key/],
    [[oidc(), access(), Response.json({ key: 'tskey-a\nb=c' })], /no auth key/],
    [[oidc(), access(), Response.json({ key: 'not-a-key' })], /no auth key/],
  ];
  for (const [responses, error] of cases) {
    await assert.rejects(mint(env, async () => responses.shift()), error);
  }
});
