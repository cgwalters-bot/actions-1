const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

// The agentic-job tag both wrappers call: a bump changes it here, in the
// six calls, the review wrapper's header and the README.
const PIN = 'v0.6.3';

const workflow = readFileSync('.github/workflows/cgwalters-review.yml', 'utf8');
const jobs = Object.fromEntries([...workflow.matchAll(/^  ([a-z]+):\n([\s\S]*?)(?=^  [a-z]+:\n|$(?![\s\S]))/gm)]
  .map(([, name, body]) => [name, body]));

function admits({ association = 'NONE', bot = false, id = 42, ids = '', draft = false, command, visibility = 'public' } = {}) {
  const expression = jobs.policy.match(/    if: >-\n([\s\S]*?)\n    uses:/)[1];
  return runInNewContext(expression, {
    github: {
      event_name: command === undefined ? 'pull_request_target' : 'issue_comment',
      event: {
        pull_request: { draft, author_association: association, user: { type: bot ? 'Bot' : 'User', id } },
        issue: { pull_request: {} }, comment: { body: command || '' },
        repository: visibility === null ? {} : { visibility, private: visibility !== 'public' },
      },
    },
    vars: { REVIEW_BOT_IDS: ids }, fromJSON: JSON.parse,
    // GitHub contains casts values to strings and compares ignoring case.
    // This is an admission regression, not a full Actions expression parser.
    contains: (array, value) => array.some(item => String(item).toLowerCase() === String(value).toLowerCase()),
    startsWith: (value, prefix) => value.toLowerCase().startsWith(prefix.toLowerCase()),
  });
}

test('automatic reviews admit trusted associations, not arbitrary contributors or drafts', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIMER', 'NONE']) {
    assert.equal(admits({ association }), ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association));
    assert.equal(admits({ association, draft: true }), false);
  }
});

test('unassociated bots wait unless their id is configured; trusted associations retain upstream admission', () => {
  for (const [bot, ids, expected] of [
    [true, '', false], [true, '[42]', true], [false, '[42]', false],
    [true, '[142]', false], [true, '["42"]', true], [true, '42', false],
  ]) assert.equal(admits({ bot, ids }), expected);
  assert.equal(admits({ bot: true, ids: '[42]', draft: true }), false);
  assert.equal(admits({ bot: true, association: 'COLLABORATOR' }), true);
});

test('commands reach event policy, which retains the caller bounds and write-role check', () => {
  assert.equal(admits({ command: '/review' }), true);
  assert.equal(admits({ command: 'please /review' }), false);
  assert.match(jobs.policy, /event: true/);
  assert.match(jobs.policy, /'workflow\/review-command.toml' \|\| 'workflow\/review.toml'/);
  assert.match(jobs.policy, /max-requests: '150'[\s\S]*budget: '500'[\s\S]*timeout: '75'/);
});

// agentic-job's opt-in for private repositories (its #739) stays off here,
// whatever a caller's bounds say: nothing runs unless the repository is public.
test('a private or internal repository is never reviewed', () => {
  for (const visibility of ['private', 'internal', null]) {
    assert.equal(admits({ association: 'OWNER', visibility }), false, String(visibility));
    assert.equal(admits({ command: '/review', visibility }), false, String(visibility));
  }
  assert.equal(admits({ association: 'OWNER' }), true);
});

test('only admitted agent jobs compete, and only pushes cancel them', () => {
  assert.match(jobs.agent, /if: \$\{\{ needs.policy.outputs.admitted == 'true' \}\}/);
  assert.match(jobs.agent, /group: review-pull-\$\{\{ github.event.pull_request.number \|\| github.event.issue.number \}\}/);
  assert.match(jobs.agent, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request_target' \}\}/);
});

// The shared agent job both wrappers call (cgwalters-agent.yml), and its steps.
const agentWorkflow = readFileSync('.github/workflows/cgwalters-agent.yml', 'utf8');
const agentJob = agentWorkflow.split('\n  agent:\n')[1];
const agentSteps = [...agentJob.matchAll(/^      - (?:uses: ([^\s]+)|name: (.+)|id: (.+))/gm)]
  .map(([, uses, name, id]) => uses || name || id);

// Since v0.6.3 the agent is the runner's user, after the secure-host image
// action, and `run` requires runner-home. The tailnet join is its job's one
// privileged step, with the register job's key, before the proxy check and
// before secure-host; nothing follows run.
test('trusted source only, one network join before dropping root, no post-agent steps', () => {
  assert.doesNotMatch(workflow, /pull_request.head|head.ref|secrets: inherit|workflow_dispatch/);
  assert.deepEqual(agentSteps.slice(4), [
    './.agentic-job-source/prepare', 'Admit the runner-user configuration',
    "Join the tailnet with the register job's key", "Make tailscaled's LocalAPI root's only",
    'Check inference proxy reachability', "The host's configuration",
    './.agentic-job-source/secure-host', 'The setup script', 'run',
  ]);
  assert.match(agentJob, /ref: \$\{\{ fromJSON\(inputs.policy\).ref \}\}/);
  assert.match(agentJob, /\n {10}runner-home: \$\{\{ runner\.temp \}\}\/agent-home\n/);
  assert.match(agentJob, /\n {10}authkey: \$\{\{ secrets\.NETWORK_SECRET \}\}\n/);
  assert.match(agentJob, /\n {10}inference-run-token: \$\{\{ secrets\.INFERENCE_RUN_TOKEN \}\}\n/);
  assert.equal([...agentJob.matchAll(/secrets\./g)].length, 2);
  for (const name of ['policy', 'check', 'apply']) {
    assert.match(jobs[name], new RegExp(`uses: [^\\n]+/${name}\\.yml@${PIN.replaceAll('.', '\\.')}`));
  }
  for (const [name, body] of Object.entries(jobs)) {
    if (name !== 'apply') assert.doesNotMatch(body, /secrets\./);
  }
});

// The identity token could mint tokens for any audience, so the job of the
// runner's-user agent holds none (agentic-job's docs/secure-host.md): only
// each wrapper's register job does, which runs nothing of the agent's and
// hands it the run token and the tailnet key as secrets of the call.
test('only the register job holds id-token; the agent job gets its outputs as secrets', () => {
  assert.match(agentWorkflow, /\n {4}permissions:\n {6}contents: read\n {6}issues: read\n {6}pull-requests: read\n {6}actions: read\n {4}outputs:/);
  const code = agentWorkflow.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /id-token|: write/);
  for (const file of ['cgwalters-agentic-job.yml', 'cgwalters-review.yml']) {
    const source = readFileSync(`.github/workflows/${file}`, 'utf8');
    const job = name => source.split(`\n  ${name}:\n`)[1].split(/\n  [a-z]+:\n/)[0];
    const agent = job('agent');
    assert.doesNotMatch(agent, /id-token|: write|\n {4}steps:/, file);
    assert.match(agent, /\n {4}uses: \.\/\.github\/workflows\/cgwalters-agent\.yml /, file);
    assert.match(agent, /\n {4}secrets:\n {6}INFERENCE_RUN_TOKEN: \$\{\{ needs\.register\.outputs\.run-token \}\}\n {6}NETWORK_SECRET: \$\{\{ needs\.register\.outputs\.network-secret \}\}\n/, file);
    const register = job('register');
    assert.match(register, /\n {4}permissions:\n {6}id-token: write\n {4}outputs:/, file);
    assert.doesNotMatch(register, /actions\/checkout|agentic-job-source/, file);
    const steps = [...register.matchAll(/^      - (?:uses: ([^\s@]+)|name: (.+)|id: (.+))/gm)]
      .map(([, uses, name, id]) => uses || name || id);
    assert.deepEqual(steps, [
      "The policy call's source repository and upload IDs", 'Refuse step debug logging',
      'Join the tailnet', "Mint the agent job's key", 'actions/download-artifact', 'register',
    ], file);
    // The mint reads the client ID and tags at the join action's own ref.
    const [, ref] = register.match(/uses: cgwalters-forge\/actions\/tailscale@(\S+)/);
    assert.match(register, new RegExp(`TAILNETS: https://raw\\.githubusercontent\\.com/cgwalters-forge/actions/${ref}/tailscale/tailnets\\.json\\n`), file);
    const others = Object.keys(Object.fromEntries([...source.matchAll(/^  ([a-z]+):\n/gm)].map(m => [m[1]])))
      .filter(name => !['register', 'check'].includes(name));
    for (const name of others) assert.doesNotMatch(job(name), /id-token/, `${file} ${name}`);
  }
});

test('both wrappers pin one release and check the proxy between join and setup', () => {
  for (const file of ['cgwalters-agentic-job.yml', 'cgwalters-review.yml']) {
    const source = readFileSync(`.github/workflows/${file}`, 'utf8');
    const calls = [...source.matchAll(/uses: (\S+\/(?:policy|check|apply)\.yml)@(\S+)/g)];
    assert.equal(calls.length, 3, file);
    for (const [, , ref] of calls) assert.equal(ref, PIN, file);
  }
  const check = 'run: agentic-job secure-host inference .agentic-job/config.toml';
  assert.equal(agentJob.split(check).length - 1, 1);
  assert.ok(agentJob.indexOf("name: Join the tailnet with the register job's key") < agentJob.indexOf(check));
  const secureHost = 'uses: ./.agentic-job-source/secure-host ';
  assert.ok(agentJob.indexOf(check) < agentJob.indexOf(secureHost));
  assert.ok(agentJob.indexOf(secureHost) < agentJob.indexOf('uses: ./.agentic-job-source/run '));
});

// v0.6.3 has no secure-host/internal: its public secure-host forwards to
// this repository's image action. Check needs the proposals upload's digest
// (its grant: review.test.mjs).
test('the agent job uses the secure-host forwarder and hands the proposals digest to check', () => {
  assert.deepEqual([...agentJob.matchAll(/uses: (\.\/\.agentic-job-source\/secure-host\S*)/g)].map(m => m[1]),
    ['./.agentic-job-source/secure-host']);
  assert.match(agentJob, /\n {6}safe-outputs-artifact-digest: \$\{\{ steps\.run\.outputs\.safe-outputs-artifact-digest \}\}\n/);
  assert.match(agentWorkflow, /\n {6}safe-outputs-artifact-digest:\n {8}value: \$\{\{ jobs\.agent\.outputs\.safe-outputs-artifact-digest \}\}\n/);
  for (const file of ['cgwalters-agentic-job.yml', 'cgwalters-review.yml']) {
    const source = readFileSync(`.github/workflows/${file}`, 'utf8');
    const check = source.split('\n  check:\n')[1].split(/\n  [a-z]+:\n/)[0];
    assert.match(check, /\n {6}safe-outputs-artifact-digest: \$\{\{ needs\.agent\.outputs\.safe-outputs-artifact-digest \}\}/, file);
  }
});

test('steering receives the dispatch item through policy metadata, or the admitted review event', () => {
  const dispatch = readFileSync('.github/workflows/cgwalters-agentic-job.yml', 'utf8');
  const policy = dispatch.split('\n  policy:\n')[1].split('\n  agent:\n')[0];
  assert.match(policy, /^      issue: \$\{\{ inputs.item \}\}$/m);
  assert.match(policy, /^      output-repo: \$\{\{ inputs.repo \}\}$/m);
  assert.match(jobs.policy, /^      event: true$/m);
  // Opt-in remains the trusted configuration's, not a new dispatcher input.
  for (const source of [dispatch, workflow]) assert.doesNotMatch(source, /watch-item:/);
});

test('real reviews are opt-in and use only the checked artifact at the admitted head', () => {
  assert.match(jobs.submit, /vars.AGENT_REAL_REVIEWS == 'true'/);
  assert.match(jobs.submit, /needs.check.result == 'success' && needs.check.outputs.artifact-id != ''/);
  assert.match(jobs.submit, /artifact-ids: \$\{\{ needs.check.outputs.artifact-id \}\}/);
  assert.match(jobs.submit, /HEAD_SHA: \$\{\{ needs.policy.outputs.review-head \}\}/);
  assert.match(jobs.submit, /return await submitReview\(process.env, output, github, core\)/);
  assert.match(jobs.apply, /!cancelled\(\)[^\n]+needs.submit.outputs.review-url == ''/);
  assert.match(jobs.status, /needs.agent.result != 'cancelled'/);
  assert.match(jobs.status, /await reportStatus\(process.env, github, core\)/);
});
