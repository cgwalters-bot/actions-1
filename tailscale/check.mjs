import { pathToFileURL } from 'node:url';

// Exchange a fresh GitHub OIDC token only to report the granted scopes.
// Neither the OIDC token nor the resulting access token is printed.
async function json(response) {
  if (!response.ok) throw new Error(`Identity request failed: HTTP ${response.status}`);
  return response.json();
}

export async function check(env = process.env, request = fetch) {
  // tailnets.json has no proxy: say so before an Invalid URL would.
  if (!env.PROXY) throw new Error('check needs the proxy input, such as the variable INFERENCE_URL');
  const oidcURL = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  oidcURL.searchParams.set('audience', env.AUDIENCE);
  const oidc = await json(await request(oidcURL, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(30000),
  }));
  if (typeof oidc.value !== 'string' || !oidc.value) throw new Error('OIDC response did not include a token');
  const token = await json(await request('https://api.tailscale.com/api/v2/oauth/token-exchange', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.OAUTH_CLIENT_ID,
      jwt: oidc.value,
    }),
    signal: AbortSignal.timeout(30000),
  }));
  if (typeof token.scope !== 'string') throw new Error('Token response did not include granted scopes');
  console.log(`Granted scopes: ${token.scope}`);
  const response = await request(new URL('/v1/runs', env.PROXY), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (response.status !== 401) throw new Error(`Proxy returned HTTP ${response.status}; expected 401`);
  console.log('Proxy returned the expected unauthenticated HTTP 401');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await check();
}
