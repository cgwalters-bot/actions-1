import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaults } from './deployment.mjs';

test('deployment.json is valid and keeps this deployment\'s configuration repository', () => {
  assert.deepEqual(defaults(), { 'agent-config-repo': 'cgwalters-forge/agenthome' });
});

test('the action writes each default as an output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deployment-'));
  try {
    const output = join(dir, 'output');
    const run = spawnSync(process.execPath, [new URL('./deployment.mjs', import.meta.url).pathname],
      { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'agent-config-repo=cgwalters-forge/agenthome\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing, malformed or unknown setting fails', () => {
  for (const text of ['[]', 'null', '{}', '{"agent-config-repo": ""}', '{"agent-config-repo": "o/c\\nx=y"}',
    '{"agent-config-repo": "no-slash"}', '{"agent-config-repo": "o/c", "agent-config-rep": "o/d"}']) {
    assert.throws(() => defaults(text), /deployment\.json/, text);
  }
  assert.deepEqual(defaults('{"agent-config-repo": "example/home"}'), { 'agent-config-repo': 'example/home' });
});
