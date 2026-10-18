import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configure } from './config.mjs';

test('egress inputs compose as arguments and copy policy to a host path', () => {
  const temp = mkdtempSync(join(tmpdir(), 'host-config-'));
  try {
    const policy = join(temp, 'policy with spaces.toml');
    writeFileSync(policy, '[[write]]\nhost = "example.com"\n');
    for (const mode of ['off', 'write-policy']) {
      const env = { ACTION: 'secure-host', RUNNER_TEMP: temp, ID: 'image', EGRESS: mode,
        EGRESS_POLICY: mode === 'off' ? '' : policy };
      configure(env, (command, args) => {
        assert.equal(command, 'sudo');
        assert.ok(args.includes('--network=none'));
        assert.ok(args.includes(`egress.write-policy=${mode === 'write-policy'}`));
        assert.equal(args.includes('egress.proxy=true'), mode === 'write-policy');
        if (mode === 'write-policy') {
          assert.ok(args.includes('egress.rust-proxy=true'));
          assert.ok(args.includes(`egress.policy=${temp}/secure-host/policy.toml`));
          assert.equal(readFileSync(join(temp, 'secure-host/policy.toml'), 'utf8'), readFileSync(policy, 'utf8'));
        }
        return { status: 0, stdout: 'checked config' };
      });
      assert.equal(readFileSync(join(temp, 'secure-host/config.toml'), 'utf8'), 'checked config');
    }
    for (const change of [{ EGRESS: 'yes' }, { EGRESS: 'off', EGRESS_POLICY: policy }]) {
      assert.throws(() => configure({ RUNNER_TEMP: temp, ...change }), /egress/);
    }
    assert.throws(() => configure({ ACTION: 'secure-host', RUNNER_TEMP: temp },
      () => ({ status: 1, stderr: 'lock-runner required' })), /lock-runner required/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('omitted inputs configure hosted.toml without the proxy', () => {
  const temp = mkdtempSync(join(tmpdir(), 'host-config-'));
  try {
    configure({ ACTION: 'secure-host', RUNNER_TEMP: temp, ID: 'image' }, (command, args) => {
      assert.ok(args.includes('egress.write-policy=false'));
      assert.ok(!args.some(arg => /^egress\.(proxy|rust-proxy|policy)=/.test(arg)));
      return { status: 0, stdout: 'checked config' };
    });
    assert.equal(readFileSync(join(temp, 'secure-host/in/config.toml'), 'utf8'),
      readFileSync('secure-host/hosted.toml', 'utf8'));
    assert.ok(!existsSync(join(temp, 'secure-host/policy.toml')));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// Its rules are parsed only by the image's proxy at setup, which the action
// waits for; a file that cannot be read fails here, before root runs anything.
test('an unreadable egress-policy fails before the image runs', () => {
  const temp = mkdtempSync(join(tmpdir(), 'host-config-'));
  try {
    for (const policy of [join(temp, 'missing.toml'), temp]) {
      assert.throws(() => configure({ ACTION: 'secure-host', RUNNER_TEMP: temp, ID: 'image',
        EGRESS: 'write-policy', EGRESS_POLICY: policy }, () => assert.fail('must not run')),
      error => /^(ENOENT|EISDIR)$/.test(error.code) && error.path === policy);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
