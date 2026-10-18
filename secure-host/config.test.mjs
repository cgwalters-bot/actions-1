import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
