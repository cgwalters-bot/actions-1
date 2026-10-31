import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaults } from './deployment.mjs';

const OURS = { 'agent-config-repo': 'cgwalters-forge/agenthome', 'agent-model': 'praxis/gpt-6.1-sol' };

test('deployment.json is valid and keeps this deployment\'s defaults', () => {
  assert.deepEqual(defaults(), OURS);
});

test('the action writes each default as an output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deployment-'));
  try {
    const output = join(dir, 'output');
    const run = spawnSync(process.execPath, [new URL('./deployment.mjs', import.meta.url).pathname],
      { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'agent-config-repo=cgwalters-forge/agenthome\nagent-model=praxis/gpt-6.1-sol\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing, malformed or unknown setting fails', () => {
  const valid = { 'agent-config-repo': 'example/home', 'agent-model': 'devstral-small-latest' };
  const cases = [
    ['[]', /deployment\.json must be an object/],
    ['null', /deployment\.json must be an object/],
    ['{}', /deployment\.json: missing setting agent-config-repo/],
    [{ 'agent-config-repo': 'example/home' }, /missing setting agent-model/],
    [{ 'agent-model': 'p/m' }, /missing setting agent-config-repo/],
    [{ ...valid, 'agent-config-repo': '' }, /agent-config-repo must match/],
    [{ ...valid, 'agent-config-repo': 'o/c\nx=y' }, /agent-config-repo must match/],
    [{ ...valid, 'agent-config-repo': 'no-slash' }, /agent-config-repo must match/],
    [{ ...valid, 'agent-model': '' }, /agent-model must match/],
    [{ ...valid, 'agent-model': 'p/m\nx=y' }, /agent-model must match/],
    [{ ...valid, 'agent-model': 'a/b/c' }, /agent-model must match/],
    [{ ...valid, 'agent-model': 42 }, /agent-model must match/],
    [{ ...valid, 'agent-config-rep': 'o/d' }, /unknown setting agent-config-rep/],
  ];
  for (const [settings, error] of cases) {
    const text = typeof settings === 'string' ? settings : JSON.stringify(settings);
    assert.throws(() => defaults(text), error, text);
  }
  assert.deepEqual(defaults(JSON.stringify(valid)), valid);
});
