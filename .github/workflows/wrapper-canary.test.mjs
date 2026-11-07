import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const { changesWrapper, needsCanary, problems, checkCanary, runCanary } = createRequire(import.meta.url)('./wrapper-canary.cjs');
const sha = 'a'.repeat(40);
const base = 'b'.repeat(40);
const repo = { owner: 'cgwalters-forge', repo: 'actions' };
const context = { repo, ref: 'refs/heads/main', sha: base, payload: { pull_request: {
  number: 138, state: 'open', changed_files: 1, base: { sha: base, ref: 'main' }, head: { sha },
} } };
const core = { info() {}, warning() {} };
const wrapper = 'cgwalters-forge/actions/.github/workflows/cgwalters-review.yml';
const jobs = ['review / agent / agent', 'review / check / check'].map(name => ({ name, conclusion: 'success' }));
const run = { id: 1, status: 'completed', conclusion: 'success', referenced_workflows: [{ path: `${wrapper}@wrapper-canary`, sha }] };

test('dependency, helper, shared agent and renamed paths require the canary', () => {
  for (const filename of ['.github/workflows/cgwalters-agentic-job.yml', '.github/workflows/cgwalters-review.yml',
    '.github/workflows/cgwalters-agent.yml', '.github/workflows/wrapper-canary.cjs', 'admit/action.yml',
    'tailscale/join.mjs', 'deployment/deployment.json', 'secure-host/action.yml', 'sandbox-share/action.yml']) {
    assert.equal(changesWrapper([{ filename }]), true, filename);
    assert.equal(changesWrapper([{ filename: 'old', previous_filename: filename }]), true, filename);
  }
  assert.equal(changesWrapper([{ filename: 'README.md' }]), false);
  assert.equal(needsCanary({ changed_files: 3001 }, Array(3000).fill({ filename: 'a' })), true);
  assert.equal(needsCanary({}, []), true);
});

test('require exact wrapper SHA and successful agent, handback check and terminal run', () => {
  const args = { run, jobs, workflow: wrapper, job: 'review', sha };
  assert.deepEqual(problems(args), []);
  for (const changed of [
    { run: { ...run, referenced_workflows: [] } },
    { run: { ...run, referenced_workflows: [{ path: `${wrapper}@main`, sha: base }] } },
    { run: { ...run, conclusion: 'failure' } },
    { run: { ...run, status: 'in_progress' } },
    { jobs: [] },
    { jobs: jobs.map(job => ({ ...job, conclusion: 'skipped' })) },
    { jobs: [...jobs, jobs[0]] },
  ]) assert.ok(problems({ ...args, ...changed }).length, JSON.stringify(changed));
});

function gateFixture() {
  const evidence = { id: 42, path: '.github/workflows/wrapper-canary.yml', display_title: `wrapper canary 138 ${sha}`,
    head_sha: base, status: 'completed', conclusion: 'success' };
  const state = { files: [{ filename: '.github/workflows/cgwalters-review.yml' }], runs: [evidence],
    jobs: [{ name: 'canary', conclusion: 'success' }], calls: 0 };
  state.pull = structuredClone(context.payload.pull_request);
  const github = { rest: { pulls: { listFiles: 'files', async get() { state.calls++; return { data: state.pull }; } }, actions: {
    listJobsForWorkflowRun: 'jobs', async listWorkflowRuns() { state.calls++; return { data: { workflow_runs: state.runs } }; },
  } }, async paginate(method) { state.calls++; return state[method]; } };
  return { state, args: { github, context, core, env: { REQUIRED: 'true' } } };
}

test('gate is off by default and unrelated complete diffs do not require a canary', async () => {
  const { args, state } = gateFixture();
  await checkCanary({ ...args, env: {} });
  assert.equal(state.calls, 0);
  state.files = [{ filename: 'README.md' }];
  await checkCanary(args);
  assert.equal(state.calls, 2);
});

test('gate accepts only matching head and current trusted base with an executed canary', async () => {
  await checkCanary(gateFixture().args);
  for (const field of ['display_title', 'head_sha', 'status', 'conclusion', 'path']) {
    const { args, state } = gateFixture();
    state.runs[0][field] = 'wrong';
    await assert.rejects(checkCanary(args), /needs a successful wrapper canary/);
  }
  const { args, state } = gateFixture();
  state.jobs[0].conclusion = 'skipped';
  await assert.rejects(checkCanary(args), /skipped/);
});

test('gate refuses a base advance or moved PR on a rerun of the old event', async () => {
  for (const field of ['base', 'head']) {
    const { args, state } = gateFixture();
    state.pull[field].sha = 'c'.repeat(40);
    await assert.rejects(checkCanary(args), field === 'base' ? /Base advanced/ : /PR moved/);
  }
  // An unrelated PR needs no canary, so a base advance does not fail it.
  const { args, state } = gateFixture();
  state.pull.base.sha = 'c'.repeat(40);
  state.files = [{ filename: 'README.md' }];
  await checkCanary(args);
});

function controllerFixture() {
  const state = { clock: 0, cancelled: [], dispatches: 0, queries: 0, done: true };
  const pull = { state: 'open', base: { ref: 'main' }, head: { sha } };
  const target = { ...pull, draft: false, merged: false, head: { sha: base, repo: { full_name: 'cgwalters-forge-stage/board-test' } } };
  const child = (review) => ({ id: review ? 2 : 1, display_title: `wrapper canary dispatch ${sha}`, head_sha: base,
    event: review ? 'pull_request_target' : 'workflow_dispatch', status: state.done ? 'completed' : 'in_progress',
    conclusion: state.done ? 'success' : null, pull_requests: [{ number: 2, head: { sha: base } }],
    referenced_workflows: [{ path: `${repo.owner}/${repo.repo}/.github/workflows/${review ? 'cgwalters-review' : 'cgwalters-agentic-job'}.yml@wrapper-canary`, sha }] });
  const github = { rest: {
    git: { async getRef() { return { data: { object: { sha } } }; } },
    pulls: { async get(args) { return { data: args.repo === 'actions' ? pull : target }; }, async update() {} },
    actions: {
      listJobsForWorkflowRun: 'jobs',
      async createWorkflowDispatch() { state.dispatches++; },
      async listWorkflowRuns(args) { state.queries++; return { data: { total_count: 1, workflow_runs: [child(args.repo === 'board-test')] } }; },
      async getWorkflowRun(args) { return { data: child(args.repo === 'board-test') }; },
      async cancelWorkflowRun(args) { state.cancelled.push(args.run_id); },
    },
  }, async paginate(method, args) { return ['agent / agent', 'check / check'].map(suffix => ({
    name: `${args.repo === 'board-test' ? 'review' : 'dispatch'} / ${suffix}`, conclusion: 'success',
  })); } };
  return { state, args: { github, context, core, env: { PULL: '138', SHA: sha, ISSUE: '1', SCRATCH_PULL: '2' },
    now: () => state.clock, sleep: async () => { state.clock += 60_000; } } };
}

test('controller starts two real paths and binds their evidence', async () => {
  const { args, state } = controllerFixture();
  await runCanary(args);
  assert.equal(state.dispatches, 1);
  assert.equal(state.queries, 2);
  assert.deepEqual(state.cancelled, []);
});

test('controller cancels both sessions at eight minutes, rather than waiting 75', async () => {
  const { args, state } = controllerFixture();
  state.done = false;
  await assert.rejects(runCanary(args), /eight-minute/);
  assert.equal(state.clock, 8 * 60_000);
  assert.deepEqual(state.cancelled, [1, 2]);
});

test('one failed cancellation does not strand its sibling or mask timeout', async () => {
  const { args, state } = controllerFixture();
  state.done = false;
  args.github.rest.actions.cancelWorkflowRun = async ({ run_id }) => {
    state.cancelled.push(run_id);
    if (run_id === 1) throw new Error('already finished');
  };
  await assert.rejects(runCanary(args), /eight-minute/);
  assert.deepEqual(state.cancelled, [1, 2]);
});

test('unadmitted head and non-default controller fail before dispatch', async () => {
  for (const changed of [{ env: { PULL: '138', SHA: base, ISSUE: '1', SCRATCH_PULL: '2' } },
    { context: { ...context, ref: 'refs/heads/untrusted' } }]) {
    const { args, state } = controllerFixture();
    await assert.rejects(runCanary({ ...args, ...changed }));
    assert.equal(state.dispatches, 0);
  }
});

test('controller has no dangerous trigger, no head checkout; child selects real opencode', () => {
  const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
  for (const file of ['./wrapper-canary.yml', './wrapper-canary-dispatch.yml']) {
    const text = read(file);
    assert.doesNotMatch(text, /pull_request_target:|workflow_run:|zizmor: ignore/);
    assert.match(text, /github.ref == 'refs\/heads\/main'/);
    assert.match(text, /WRAPPER_CANARY_REQUIRED == 'true'/);
    assert.doesNotMatch(text, /ref:.*inputs\.sha/);
  }
  assert.match(read('./wrapper-canary-dispatch.yml'), /agent: opencode/);
  assert.match(read('./wrapper-canary.yml'), /environment: wrapper-canary/);
});

test('canary policy request uses noop-only admission and a short timeout', () => {
  const text = readFileSync(new URL('./cgwalters-agentic-job.yml', import.meta.url), 'utf8');
  assert.match(text, /canary:\n {8}description:.*\n {8}type: boolean\n {8}default: false/);
  assert.match(text, /outputs: \$\{\{ inputs.canary && 'noop'/);
  assert.match(text, /max-outputs: \$\{\{ \(inputs.canary \|\| inputs.kind == 'review'\) && '1'/);
  assert.match(text, /timeout: \$\{\{ inputs.canary && '3' \|\| '75' \}\}/);
});

// Download the binary from the exact release named by the wrapper to exercise
// the real compiler without requiring network or a binary in ordinary CI.
test('pinned policy compiler admits the actual canary request, not ordinary implement outputs',
  { skip: !process.env.CANARY_POLICY_BINARY }, () => {
    const args = ['policy', '--allow', new URL('../agentic-job/canary.toml', import.meta.url).pathname,
      '--repo', 'cgwalters-forge-stage/board-test', '--clone-url', 'https://github.com/cgwalters-forge-stage/board-test',
      '--base', 'main', '--kind', 'branch'];
    const admitted = spawnSync(process.env.CANARY_POLICY_BINARY, [...args, '--outputs', 'noop', '--max-outputs', '1'], { encoding: 'utf8' });
    assert.equal(admitted.status, 0, admitted.stderr);
    assert.deepEqual(JSON.parse(admitted.stdout).safe_outputs, { noop: { max: 1 } });
    const rejected = spawnSync(process.env.CANARY_POLICY_BINARY, [...args, '--outputs', 'create_pull_request,noop,missing_tool,missing_data', '--max-outputs', '3'], { encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
  });
