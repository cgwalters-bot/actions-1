import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { settings } from './setup.mjs';

// cgwalters-forge's broker moved; the others stay on the old host until
// their tailnet membership of the new one is confirmed.
test('known organizations supply join settings and proxy', () => {
  for (const [owner, proxy] of [
    ['bootc-dev', 'http://100.114.231.4:18080'],
    ['cgwalters-forge-stage', 'http://100.114.231.4:18080'],
    ['cgwalters-forge', 'http://100.114.231.4:18080'],
  ]) {
    const result = settings(owner);
    assert.equal(result.audience, `api.tailscale.com/${result['oauth-client-id']}`);
    assert.equal(result.tags, 'tag:bootc-dev-sandbox');
    assert.equal(result.proxy, proxy);
  }
});

test('each setting can be overridden and audience follows an overridden client', () => {
  assert.deepEqual(settings('bootc-dev', {
    'oauth-client-id': 'custom', tags: 'tag:custom', proxy: 'http://example.test',
  }), {
    'oauth-client-id': 'custom', audience: 'api.tailscale.com/custom',
    tags: 'tag:custom', proxy: 'http://example.test',
  });
  assert.equal(settings('bootc-dev', { audience: 'custom' }).audience, 'custom');
  assert.equal(settings('bootc-dev', { tags: '' }).tags, 'tag:bootc-dev-sandbox');
});

test('unknown owners and output injection fail clearly', () => {
  for (const owner of ['unknown', '__proto__', 'constructor']) {
    assert.throws(() => settings(owner), /No tailnet settings for GitHub organization/);
  }
  assert.throws(() => settings('bootc-dev', { proxy: 'url\ninjected=value' }), /single-line/);
});

test('an unlisted organization joins with its own client ID and tags, both', () => {
  assert.deepEqual(settings('other-org', { 'oauth-client-id': 'other', tags: 'tag:other' }), {
    'oauth-client-id': 'other', audience: 'api.tailscale.com/other', tags: 'tag:other', proxy: '',
  });
  assert.equal(settings('other-org', {
    'oauth-client-id': 'other', tags: 'tag:other', proxy: 'http://example.test',
  }).proxy, 'http://example.test');
  for (const overrides of [{ 'oauth-client-id': 'other' }, { tags: 'tag:other' },
    { 'oauth-client-id': 'other', tags: '' }, { audience: 'a', proxy: 'http://example.test' }]) {
    assert.throws(() => settings('other-org', overrides), /No tailnet settings/);
  }
  for (const owner of ['__proto__', 'constructor']) {
    assert.equal(settings(owner, { 'oauth-client-id': 'other', tags: 'tag:other' }).tags, 'tag:other');
  }
  assert.throws(() => settings('other-org', { 'oauth-client-id': 'other', tags: 'tag:a\ninjected=value' }), /single-line/);
});

// Each wrapper's register job, the one federated join, passes the calling
// repository's variables, never a dispatcher's input, so that another
// deployment sets its login once; the agent job joins with its key.
test('both wrappers join with the repository variables for the login', () => {
  const read = file => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
  for (const file of ['cgwalters-agentic-job.yml', 'cgwalters-review.yml']) {
    const join = read(file).split('- name: Join the tailnet and mint the agent job\'s key\n')[1]
      .split(/\n {6}- /)[0].split('\n        with:\n')[1];
    assert.match(join, /\n {10}oauth-client-id: \$\{\{ vars\.AGENTIC_JOB_TAILSCALE_OAUTH_CLIENT_ID \}\}\n/, file);
    assert.match(join, /\n {10}tags: \$\{\{ vars\.AGENTIC_JOB_TAILSCALE_TAGS \}\}(\n|$)/, file);
    assert.doesNotMatch(join, /inputs\./, file);
  }
  const agent = read('cgwalters-agent.yml').split('- name: Join the tailnet\n')[1].split(/\n {6}- /)[0];
  assert.doesNotMatch(agent, /oauth-client-id|vars\.|inputs\./);
});

test('the setup subprocess appends outputs and rejects injection before writing', () => {
  const directory = mkdtempSync(join(homedir(), 'tailscale-output-'));
  const output = join(directory, 'output');
  const prefix = 'existing=value\n';
  try {
    for (const scenario of [
      { owner: 'bootc-dev', overrides: {}, status: 0 },
      { owner: 'cgwalters-forge', overrides: {
        OAUTH_CLIENT_ID: 'custom', AUDIENCE: 'custom-audience',
        TAGS: 'tag:custom', PROXY: 'http://example.test',
      }, status: 0 },
      { owner: 'unknown', overrides: {}, status: 1, error: /No tailnet settings/ },
      { owner: 'unknown', overrides: { OAUTH_CLIENT_ID: 'other', TAGS: 'tag:other' }, status: 0 },
      { owner: 'unknown', overrides: { OAUTH_CLIENT_ID: 'other' }, status: 1, error: /No tailnet settings/ },
      ...['\n', '\r', '\r\n'].map(newline => ({
        owner: 'bootc-dev', overrides: { PROXY: `url${newline}injected=value` },
        status: 1, error: /single-line/,
      })),
    ]) {
      writeFileSync(output, prefix);
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./setup.mjs', import.meta.url))], {
        encoding: 'utf8',
        env: {
          ...process.env, OAUTH_CLIENT_ID: '', AUDIENCE: '', TAGS: '', PROXY: '',
          REPOSITORY_OWNER: scenario.owner, GITHUB_OUTPUT: output, ...scenario.overrides,
        },
      });
      assert.ifError(result.error);
      assert.equal(result.status, scenario.status, result.stderr);
      if (scenario.error) {
        assert.match(result.stderr, scenario.error);
        assert.equal(readFileSync(output, 'utf8'), prefix);
      } else {
        const overrides = Object.fromEntries(Object.entries(scenario.overrides)
          .map(([key, value]) => [key.toLowerCase().replaceAll('_', '-'), value]));
        const expected = Object.entries(settings(scenario.owner, overrides))
          .map(([key, value]) => `${key}=${value}\n`).join('');
        assert.equal(readFileSync(output, 'utf8'), prefix + expected);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the composite exposes resolution after LocalAPI lockdown', () => {
  const action = readFileSync(new URL('./action.yml', import.meta.url), 'utf8');
  assert.match(action, /\n  resolve-proxy:\n[^\n]+\n    required: false\n    default: "false"/);
  assert.match(action, /\n  proxy-address:\n[^\n]+\n    value: \$\{\{ steps\.resolve-proxy\.outputs\.proxy-address \}\}/);
  const steps = action.split(/\n    - name: /);
  const lockdown = steps.findIndex(step => step.startsWith("Make tailscaled's LocalAPI root's only"));
  const resolver = steps.findIndex(step => step.includes('id: resolve-proxy'));
  assert.ok(lockdown !== -1 && resolver > lockdown);
  assert.match(steps[lockdown], /if: always\(\)/);
  assert.match(steps[resolver], /if: success\(\) && steps\.join\.outcome == 'success' && inputs\.resolve-proxy == 'true'/);
  assert.match(steps[resolver], /PROXY: \$\{\{ steps\.settings\.outputs\.proxy \}\}/);
  assert.match(steps[resolver], /run: node "\$ACTION_PATH\/setup\.mjs" resolve-proxy/);
});

test('the setup subprocess resolves the proxy without logging peer status', t => {
  const dir = mkdtempSync(join(homedir(), 'resolve-proxy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, 'output');
  const calls = join(dir, 'calls');
  writeFileSync(join(dir, 'sudo'), `#!/bin/sh
printf '%s\n' "$*" >> "$CALLS"
printf '%s\n' 'private status diagnostics' >&2
printf '%s\n' "$PEER_STATUS"
exit "$SUDO_EXIT"
`, { mode: 0o700 });

  const broker = 'broker.tailnet.ts.net';
  const peer = (DNSName, TailscaleIPs) => ({ DNSName, TailscaleIPs });
  const exact = peer(`${broker}.`, ['fd7a:115c:a1e0::1', '100.64.0.2', '100.64.0.3']);
  const lookalike = peer(`other.${broker}.`, ['100.64.0.1']);
  for (const scenario of [
    { proxy: '', skip: true },
    { proxy: 'http://192.0.2.1:18080', skip: true, address: '192.0.2.1' },
    { proxy: 'https://[2001:db8::1]', skip: true },
    { proxy: `https://${broker}.example`, skip: true },
    { proxy: `https://${broker}..`, skip: true, error: /Invalid .ts.net/ },
    { proxy: 'https://bad_name.ts.net', skip: true, error: /Invalid .ts.net/ },
    { proxy: 'not-a-url', skip: true, error: /Invalid inference proxy URL/ },
    { status: { Peer: { lookalike, exact } }, address: '100.64.0.2' },
    { proxy: `https://${broker}.:8443/path`, status: { Peer: { exact: { ...exact, DNSName: broker } } }, address: '100.64.0.2' },
    { status: { Self: exact, Peer: { lookalike } }, error: /No Tailscale peer matches/ },
    { status: { Peer: { exact, duplicate: { DNSName: broker } } }, error: /Ambiguous/ },
    { status: { Peer: [] }, error: /no Peer object/ },
    { status: { Peer: { exact: { DNSName: broker } } }, error: /no TailscaleIPs array/ },
    { status: { Peer: { exact: peer(broker, ['100.64.0.2', 'not-an-ip']) } }, error: /invalid TailscaleIP/ },
    { status: { Peer: { exact: peer(broker, ['fd7a:115c:a1e0::1', '::ffff:100.64.0.2']) } }, error: /no IPv4/ },
    { rawStatus: '{', error: /Could not decode Tailscale status/ },
    { sudoExit: '1', status: { Peer: { exact } }, error: /Could not read Tailscale status/ },
  ]) {
    const prefix = 'existing=value\n';
    writeFileSync(output, prefix);
    writeFileSync(calls, '');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./setup.mjs', import.meta.url)), 'resolve-proxy'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        PROXY: scenario.proxy ?? `https://${broker}`,
        GITHUB_OUTPUT: output,
        CALLS: calls,
        PEER_STATUS: scenario.rawStatus ?? JSON.stringify(scenario.status ?? {}),
        SUDO_EXIT: scenario.sudoExit ?? '0',
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, scenario.error ? 1 : 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /private status diagnostics|100\.64\.0\./);
    if (scenario.error) assert.match(result.stderr, scenario.error);
    assert.equal(readFileSync(calls, 'utf8'), scenario.skip ? '' : '-n /usr/local/bin/tailscale status --json\n');
    assert.equal(readFileSync(output, 'utf8'), prefix + (scenario.address ? `proxy-address=${scenario.address}\n` : ''));
  }
});
