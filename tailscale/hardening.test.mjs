import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Execute the actual action's shell with a recording sudo double. This tests
// control flow without claiming to verify kernel permissions or a live join.
test('hardening runs after both successful and failed joins', () => {
  const action = readFileSync(new URL('./action.yml', import.meta.url), 'utf8');
  const step = action.split('    - name: Make tailscaled\'s LocalAPI root\'s only\n')[1]
    .split('    # After the join, so that a key is minted only for a login that works.\n')[0];
  assert.match(step, /if: always\(\)/);
  assert.match(step, /JOINED: \$\{\{ steps\.join\.outcome == 'success' \}\}/);
  const script = step.split('      run: |\n')[1]
    .split('\n').map(line => line.replace(/^        /, '')).join('\n');
  const directory = mkdtempSync(join(homedir(), 'tailscale-hardening-'));
  const log = join(directory, 'calls');
  try {
    writeFileSync(join(directory, 'sudo'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'test') {
  process.exit(process.env[args[1] === '-f' ? 'CLI_EXISTS' : 'DIRECTORY_EXISTS'] === 'true' ? 0 : 1);
}
if (args[0] === 'chmod' && process.env.FAIL_CHMOD === 'true') process.exit(1);
if (args[0] === 'stat') console.log('700 root:root');
`, { mode: 0o700 });
    for (const scenario of [
      { joined: 'true', cli: 'true', directory: 'true', status: 0 },
      { joined: 'false', cli: 'true', directory: 'true', status: 0 },
      { joined: 'false', cli: 'false', directory: 'false', status: 0 },
      { joined: 'true', cli: 'true', directory: 'true', failChmod: 'true', status: 1 },
    ]) {
      writeFileSync(log, '');
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env, PATH: `${directory}:${process.env.PATH}`, CALL_LOG: log,
          JOINED: scenario.joined, CLI_EXISTS: scenario.cli,
          DIRECTORY_EXISTS: scenario.directory, FAIL_CHMOD: scenario.failChmod || 'false',
        },
      });
      assert.ifError(result.error);
      assert.equal(result.status, scenario.status, result.stderr);
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const expected = [['test', '-f', '/usr/local/bin/tailscale']];
      if (scenario.cli === 'true') expected.push(['chmod', '0700', '/usr/local/bin/tailscale']);
      if (!scenario.failChmod) {
        expected.push(['test', '-d', '/var/run/tailscale']);
        if (scenario.directory === 'true') {
          expected.push(['chmod', '0700', '/var/run/tailscale'],
            ['stat', '-c', '%a %U:%G', '/var/run/tailscale']);
          if (scenario.joined === 'true') expected.push(['/usr/local/bin/tailscale', 'status', '--self']);
        }
      }
      assert.deepEqual(calls, expected, JSON.stringify(scenario));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
