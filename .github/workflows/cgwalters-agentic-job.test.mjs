import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('./cgwalters-agentic-job.yml', import.meta.url), 'utf8');

// agentic-job is called at one release tag: check, apply, prepare and run
// refuse calls that resolved to different commits, which following main
// produced for runs spanning an agentic-job merge (tracker#544). Our own
// tailscale action still follows main.
test('agentic-job is called at one release tag, our tailscale at main', () => {
  const refs = [...workflow.matchAll(/uses: cgwalters-forge\/(\S+)@(\S+)/g)];
  assert.deepEqual(refs.map(match => match[1]), [
    'agentic-job/.github/workflows/policy.yml',
    'actions/tailscale',
    'agentic-job/.github/workflows/check.yml',
    'agentic-job/.github/workflows/apply.yml',
  ]);
  const tags = new Set(refs.filter(([, path]) => path.startsWith('agentic-job/')).map(match => match[2]));
  assert.equal(tags.size, 1);
  assert.match([...tags][0], /^v\d+\.\d+\.\d+$/);
  assert.equal(refs.find(([, path]) => path === 'actions/tailscale')[2], 'main');
  assert.doesNotMatch(workflow, /PINNED_SHA/);
  assert.match(workflow, /\n {10}EXPECTED_REPOSITORY: cgwalters-forge\/agentic-job\n/);
});

// Dependabot moves the tag, all three calls in one pull request, without
// the third-party cooldown.
test('dependabot proposes new agentic-job tags as one group', () => {
  const config = readFileSync(new URL('../dependabot.yml', import.meta.url), 'utf8');
  assert.match(config, /\n {6}interval: daily\n/);
  assert.match(config, /\n {6}agentic-job:\n {8}patterns: \["cgwalters-forge\/agentic-job\*"\]\n/);
  assert.match(config, /\n {6}exclude: \["cgwalters-forge\/agentic-job\*"\]\n/);
});

// Third-party actions stay pinned by full commit; dependabot moves them.
test('every other action is pinned by full commit', () => {
  for (const file of ['./cgwalters-agentic-job.yml', './ci.yml', '../../tailscale/action.yml']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    const others = [...text.matchAll(/uses: (?!cgwalters-forge\/|\.\/)(\S+)@(\S+)/g)];
    assert.ok(others.length > 0, file);
    for (const [, name, ref] of others) assert.match(ref, /^[0-9a-f]{40}$/, `${file}: ${name}`);
  }
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
