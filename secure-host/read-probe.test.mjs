import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startProbe } from './read-probe.mjs';

const env = { ...process.env, SECURE_HOST_READ_PROBE: 'not-a-secret',
  RUNNER_TRACKING_ID: 'read-probe-test' };

function pidFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'read-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'probe.pid');
}

test('the real detached probe retains its exact PID, canary and tracking ID', async (t) => {
  const file = pidFile(t);
  const pid = await startProbe(file, { env });
  t.after(() => process.kill(pid, 'SIGKILL'));
  assert.equal(readFileSync(file, 'utf8'), `${pid}\n`);
  process.kill(pid, 0);
  const entries = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  assert.ok(entries.includes('SECURE_HOST_READ_PROBE=not-a-secret'));
  assert.ok(entries.includes('RUNNER_TRACKING_ID=read-probe-test'));
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
  assert.equal(Number(stat[5]), pid, 'child is its own session leader');
});

test('waits for delayed readiness, not merely a spawned PID or readable canary', async (t) => {
  const file = pidFile(t);
  const pending = startProbe(file, { env, args: ['-e', `
    setTimeout(() => process.exit(0), 10000);
    setTimeout(() => process.send({pid: process.pid}), 300);
  `] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(existsSync(file), false);
  const pid = await pending;
  t.after(() => process.kill(pid, 'SIGKILL'));
  assert.equal(readFileSync(file, 'utf8'), `${pid}\n`);
});

for (const [name, code, expected] of [
  ['timeout', 'setTimeout(() => process.exit(0), 10000)', /timed out/],
  ['early exit', 'process.exit(1)', /exited|disconnected/],
  ['wrong PID', 'process.send({pid: process.pid + 1}); setTimeout(() => {}, 10000)', /PID mismatch/],
  ['missing canary', 'process.send({pid: process.pid}); setTimeout(() => {}, 10000)', /missing the canary/],
]) {
  test(`fails closed on ${name} without publishing a PID`, async (t) => {
    const file = pidFile(t);
    const childEnv = { ...env };
    if (name === 'missing canary') delete childEnv.SECURE_HOST_READ_PROBE;
    await assert.rejects(startProbe(file, {
      env: childEnv, args: ['-e', code], timeoutMs: name === 'timeout' ? 100 : 5000,
    }), expected);
    assert.equal(existsSync(file), false);
  });
}

test('the workflow command exits on timeout rather than hanging on IPC', async (t) => {
  const file = pidFile(t);
  const script = `
    import { startProbe } from './secure-host/read-probe.mjs';
    await startProbe(${JSON.stringify(file)}, {
      args: ['-e', 'setTimeout(() => {}, 10000)'], timeoutMs: 100,
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: 'ignore', timeout: 3000,
  });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.equal(signal, null);
  assert.equal(existsSync(file), false);
});
