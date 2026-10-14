import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('./cgwalters-agentic-job.yml', import.meta.url), 'utf8');

// check, apply, prepare and run refuse a mismatch at run time; this catches
// a partial repin before every run fails on it.
test('every agentic-job pin names the same full commit', () => {
  const pins = [...workflow.matchAll(/cgwalters-forge\/agentic-job\/\.github\/workflows\/[a-z]+\.yml@(\S+)/g)]
    .map(match => match[1]);
  assert.equal(pins.length, 3);
  const [pin] = pins;
  assert.match(pin, /^[0-9a-f]{40}$/);
  assert.deepEqual(pins, [pin, pin, pin]);
  assert.match(workflow, new RegExp(`PINNED_SHA: ${pin}\n`));
  assert.match(workflow, new RegExp(`^# ${pin} `, 'm'));
});

// The target job's actual script, with doubles for github-script's globals.
const script = workflow.split('          script: |\n')[1].split('\n\n')[0]
  .split('\n').map(line => line.replace(/^ {12}/, '')).join('\n');
const AsyncFunction = (async () => {}).constructor;

async function target(env, { pull = false } = {}) {
  const outputs = {};
  const core = { setOutput: (name, value) => { outputs[name] = value; } };
  const github = { rest: { issues: { get: async ({ issue_number }) => ({
    data: { number: issue_number, title: 't', body: 'b', ...(pull ? { pull_request: {} } : {}) },
  }) } } };
  const context = { eventName: 'workflow_call' };
  const environment = {
    TARGET_REPO: 'example/repo', TARGET_ITEM: '7', PROFILE: 'implement', TASK: 'Do it.',
    SKILLS: 'false', AGENT: 'opencode', AGENT_MODEL: 'p/m', AGENT_RUNNER: '"ubuntu-26.04"',
    INFERENCE_URL: 'http://proxy', INFERENCE_AUDIENCE: 'aud', AGENT_CONFIG_REPO: 'o/c',
    AGENT_CONFIG_PATH: 'p', APPLY_ENVIRONMENT: 'apply', ...env,
  };
  await new AsyncFunction('core', 'github', 'context', 'process', script)(
    core, github, context, { env: environment });
  return outputs;
}

test('skills are off by default and the task keeps its one-line contract', async () => {
  const outputs = await target({});
  assert.equal(outputs.skills, 'false');
  assert.doesNotMatch(outputs.task, /skill/);
  assert.match(outputs.task, /^Profile: implement\. Implement proposes one draft pull request\./);
});

test('skills turn on only for implement with claude or opencode', async () => {
  for (const agent of ['claude', 'opencode']) {
    const outputs = await target({ SKILLS: 'true', AGENT: agent });
    assert.equal(outputs.skills, 'true');
    assert.match(outputs.task, /^Profile: implement\. Use the implement skill\. /);
  }
  // agentic-job refuses skills for these agents: the input must not fail
  // their runs.
  for (const agent of ['fake', 'vibe']) {
    const outputs = await target({ SKILLS: 'true', AGENT: agent, AGENT_MODEL: 'devstral-small-latest' });
    assert.equal(outputs.skills, 'false');
    assert.doesNotMatch(outputs.task, /skill/);
  }
  for (const [profile, pull] of [['triage', false], ['research', false], ['review', true], ['fix', true]]) {
    const outputs = await target({ SKILLS: 'true', PROFILE: profile }, { pull });
    assert.equal(outputs.skills, 'false', profile);
    assert.doesNotMatch(outputs.task, /skill/, profile);
  }
});

test('policy is given skills only from the target job', () => {
  assert.match(workflow, /\n {10}SKILLS: \$\{\{ inputs\.skills \}\}\n/);
  assert.match(workflow, /\n {6}agent-skills: \$\{\{ needs\.target\.outputs\.skills == 'true' \}\}\n/);
  assert.match(workflow, /\n {6}skills: \$\{\{ steps\.target\.outputs\.skills \}\}\n/);
});
