import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The wrappers' tests that execute no JavaScript are in lint/tests/wrappers.rs.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const workflow = readFileSync(new URL('./cgwalters-agentic-job.yml', import.meta.url), 'utf8');

// A repository without INFERENCE_URL falls back to the broker its runner
// joins the tailnet to reach: the wrappers and tailnets.json move together.
test('the wrappers fall back to the cgwalters-forge tailnet broker', () => {
  const tailnets = JSON.parse(readFileSync(new URL('../../tailscale/tailnets.json', import.meta.url), 'utf8'));
  const broker = tailnets['cgwalters-forge'].proxy;
  const review = readFileSync(new URL('./cgwalters-review.yml', import.meta.url), 'utf8');
  const fallbacks = [...review.matchAll(/vars\.INFERENCE_URL \|\| '([^']*)'/g)].map(match => match[1]);
  assert.deepEqual(fallbacks, [broker]);
  assert.deepEqual([...workflow.matchAll(/\n {10}BROKER_URL: (\S+)\n/g)].map(match => match[1]), [broker]);
});

// The review wrapper has no inputs and its caller passes no secret, so it
// stays on the broker: agentic-job's provider-key mode (its #740) is not
// wired here.
test('the review wrapper stays on the inference broker', () => {
  assert.doesNotMatch(read('./cgwalters-review.yml'), /INFERENCE_API_KEY|inference-register|inference-provider|inference-api-key/);
});

// Renovate's matchStrings are JavaScript regular expressions, so this one
// runs them here rather than in lint/tests/wrappers.rs.
test('Renovate tracks both wrappers review pins from main without automerge', () => {
  const config = JSON.parse(read('../renovate.json'));
  assert.equal(config.customManagers.length, 1);
  const manager = config.customManagers[0];
  assert.equal(manager.customType, 'regex');
  assert.deepEqual(manager.managerFilePatterns, ['/^\\.github/workflows/cgwalters-(?:review|agentic-job)\\.yml$/']);
  const eligible = new RegExp(manager.managerFilePatterns[0].slice(1, -1));
  for (const file of ['cgwalters-review', 'cgwalters-agentic-job']) assert.ok(eligible.test(`.github/workflows/${file}.yml`));
  assert.ok(!eligible.test('.github/workflows/review.yml'));
  assert.equal(manager.datasourceTemplate, 'git-refs');
  assert.equal(manager.packageNameTemplate, 'https://github.com/cgwalters-forge/actions');
  assert.equal(manager.currentValueTemplate, 'main');
  const pattern = new RegExp(manager.matchStrings[0], 'g');
  const wrapper = read('./cgwalters-review.yml');
  const pins = [...wrapper.matchAll(pattern)];
  assert.equal(pins.length, 3);
  for (const pin of pins) assert.match(pin.groups.currentDigest, /^[0-9a-f]{40}$/);
  // Exercise the digest-only replacement: preserve the action paths and branch.
  const updated = wrapper.replace(pattern, match => match.replace(/[0-9a-f]{40}/, 'a'.repeat(40)));
  assert.equal([...updated.matchAll(pattern)].filter(pin => pin.groups.currentDigest === 'a'.repeat(40)).length, 3);
  assert.equal([...read('./cgwalters-agentic-job.yml').matchAll(pattern)].length, 3);
  assert.deepEqual(config.packageRules, [{
    description: "Update the review wrapper's own-action commits together through review, even without release tags",
    matchManagers: ['custom.regex'], matchDatasources: ['git-refs'],
    matchPackageNames: [manager.packageNameTemplate], enabled: true,
    groupName: 'review actions', automerge: false,
  }]);
});

test('opencode or claude with no configuration repository fails in the target job', async () => {
  for (const agent of ['opencode', 'claude']) {
    await assert.rejects(target({ AGENT_CONFIG_REPO: '', AGENT: agent }), /No agent configuration repository/, agent);
    const outputs = await target({ AGENT: agent });
    assert.notEqual(outputs['agent-config-repo'], '', agent);
  }
  const outputs = await target({ AGENT_CONFIG_REPO: '', AGENT: 'vibe', AGENT_MODEL: 'devstral-small-latest' });
  assert.equal(outputs['agent-config-repo'], '');
});

// The target job's actual script, with doubles for github-script's globals.
const script = workflow.split('          script: |\n')[1].split('\n\n')[0]
  .split('\n').map(line => line.replace(/^ {12}/, '')).join('\n');
const AsyncFunction = (async () => {}).constructor;

const head = 'a'.repeat(40);
const basePolicy = `hosts = ["github.com"]
repos = ["caller/repo"]
bases = ["main"]
[github.trigger]
events = ["pull_request_target"]
roles = ["all"]
bots = ["dependabot[bot]"]
forks = true`;

async function target(env, { pull = false, caller = { private: false, visibility: 'public', default_branch: 'main' },
  pr = {}, policy = basePolicy, commandPolicy, comments = [], permission = 'write', eventName = 'workflow_dispatch', ref = 'refs/heads/main',
} = {}) {
  const outputs = {};
  const core = { setOutput: (name, value) => { outputs[name] = value; } };
  const github = { rest: {
    issues: { get: async ({ issue_number }) => ({
      data: { number: issue_number, title: 't', body: 'b', user: { login: 'item-author' }, author_association: 'MEMBER', ...(pull ? { pull_request: {} } : {}) },
    }), listComments: async () => ({ data: comments }) },
    pulls: { get: async () => ({ data: {
      number: 7, state: 'open', draft: false, head: { sha: head, repo: { full_name: 'fork/repo' } },
      base: { ref: 'main', repo: { full_name: 'caller/repo' } }, author_association: 'MEMBER',
      user: { type: 'User', login: 'author', id: 12 }, ...pr,
    } }) },
    repos: { get: async ({ owner, repo }) => {
      assert.equal(`${owner}/${repo}`, 'caller/repo');
      return { data: caller };
    }, getContent: async ({ path, ref: policyRef }) => {
      assert.equal(policyRef, 'b'.repeat(40), 'read policy at dispatched trusted SHA, never head');
      assert.ok(['workflow/review.toml', 'workflow/review-command.toml'].includes(path));
      const text = path.endsWith('review-command.toml')
        ? commandPolicy ?? policy.replace('["pull_request_target"]', '["issue_comment"]').replace('["all"]', '["write", "maintain", "admin"]').concat('\ncommands = ["/review"]') : policy;
      return { data: { type: 'file', encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') } };
    }, getCollaboratorPermissionLevel: async () => ({ data: { permission } }) },
  } };
  const context = { eventName, ref, sha: 'b'.repeat(40), payload: { repository: caller }, repo: { owner: 'caller', repo: 'repo' } };
  const environment = {
    TARGET_REPO: 'example/repo', TARGET_ITEM: '7', PROFILE: 'implement', TASK: 'Do it.',
    SKILLS: 'false', MAX_REQUESTS: '400', AGENT: 'opencode', AGENT_MODEL: 'p/m', AGENT_RUNNER: '"ubuntu-26.04"',
    INFERENCE_URL: 'http://proxy', INFERENCE_AUDIENCE: 'aud', INFERENCE_REGISTER: 'github-oidc', AGENT_CONFIG_REPO: 'o/c',
    BROKER_URL: 'http://broker', BROKER_AUDIENCE: 'broker-aud',
    AGENT_CONFIG_PATH: 'p', APPLY_ENVIRONMENT: 'apply', SESSION: 'false', IDLE_MINUTES: '',
    TAILNET_DOMAIN: '', RUN_ID: '123', RUN_ATTEMPT: '2', EXPECTED_HEAD: head, REVIEW_POOL: 'openai',
    REVIEW_POOLS: JSON.stringify({ openai: { agent: 'opencode', model: 'provider/review-model' } }), REVIEW_BOT_IDS: '', ...env,
  };
  await new AsyncFunction('core', 'github', 'context', 'process', script)(
    core, github, context, { env: environment });
  return outputs;
}

test('the event includes the item author and association for issues and pull requests', async () => {
  for (const [profile, pull] of [['implement', false], ['fix', true]]) {
    const outputs = await target({ PROFILE: profile }, { pull });
    const event = outputs.task.match(/\n<agentic-job-event>\n([^\n]+)\n<\/agentic-job-event>$/);
    assert.ok(event, profile);
    assert.deepEqual(JSON.parse(event[1]), {
      repository: 'example/repo', number: 7, title: 't', body: 'b',
      author: 'item-author', association: 'MEMBER',
    }, profile);
  }
});

// agentic-job's opt-in for private repositories (its #739) admits only the
// calling repository, so a public caller keeps it off whatever its bounds say.
test('a run from a repository that is not public fails before policy', async () => {
  for (const caller of [{ private: true, visibility: 'private' }, { private: false, visibility: 'internal' }, {}]) {
    await assert.rejects(target({}, { caller: { default_branch: 'main', ...caller } }), /only from a public repository/, JSON.stringify(caller));
  }
  assert.match(job('policy'), /\n {4}needs: target\n/);
});

test('skills are off by default and the task keeps its one-line contract', async () => {
  const outputs = await target({});
  assert.equal(outputs.skills, 'false');
  assert.doesNotMatch(outputs.task, /skill/);
  assert.match(outputs.task, /^Profile: implement\. Implement proposes one draft pull request\./);
});

test('skills turn on only for implement or fix with claude or opencode', async () => {
  for (const agent of ['claude', 'opencode']) {
    const outputs = await target({ SKILLS: 'true', AGENT: agent });
    assert.equal(outputs.skills, 'true');
    assert.match(outputs.task, /^Profile: implement\. Use the implement skill\. /);
  }
  // agentic-job refuses skills for these agents: the input must not fail
  // their runs.
  for (const agent of ['vibe']) {
    const outputs = await target({ SKILLS: 'true', AGENT: agent, AGENT_MODEL: 'devstral-small-latest' });
    assert.equal(outputs.skills, 'false');
    assert.doesNotMatch(outputs.task, /skill/);
  }
  // Fix installs them for the commit-messages skill but names no procedure.
  const fix = await target({ SKILLS: 'true', PROFILE: 'fix' }, { pull: true });
  assert.equal(fix.skills, 'true');
  assert.doesNotMatch(fix.task, /skill/);
  for (const [profile, pull] of [['triage', false], ['research', false]]) {
    const outputs = await target({ SKILLS: 'true', PROFILE: profile }, { pull });
    assert.equal(outputs.skills, 'false', profile);
    assert.doesNotMatch(outputs.task, /skill/, profile);
  }
});

test('max-requests defaults to 400 and passes through for a real agent', async () => {
  assert.match(workflow, /\n {6}max-requests:\n {8}description: [^\n]*\n {8}type: string\n {8}default: "400"\n/);
  assert.equal((await target({}))['max-requests'], '400');
  assert.equal((await target({ MAX_REQUESTS: '1000', AGENT: 'claude' }))['max-requests'], '1000');
  assert.equal((await target({ MAX_REQUESTS: '1', AGENT: 'vibe', AGENT_MODEL: 'devstral-small-latest' }))['max-requests'], '1');
  await assert.rejects(target({ AGENT: 'fake' }), /fake is unsupported with agent-user sandbox/);
});

test('max-requests outside 1 to 1000 fails the run', async () => {
  for (const value of ['', '0', '1001', '-1', '01', '4e2', ' 400', '400 ']) {
    await assert.rejects(target({ MAX_REQUESTS: value }), /max-requests must be/, JSON.stringify(value));
  }
});

// The text of one job, from its key to the next job's.
function job(name) {
  return `\n${workflow.split(`\n  ${name}:\n`)[1].split(/\n {2}[a-z-]+:\n/)[0]}`;
}

test('a run is no session unless asked, and passes policy nothing new', async () => {
  assert.match(workflow, /\n {6}session:\n {8}description: [^\n]*\n {8}type: boolean\n {8}default: false\n/);
  assert.match(workflow, /\n {6}idle-minutes:\n {8}description: [^\n]*\n {8}type: string\n {8}default: ""\n/);
  const outputs = await target({ TAILNET_DOMAIN: 'example.ts.net' });
  assert.equal(outputs.session, 'false');
  assert.equal(outputs['idle-minutes'], '');
  assert.equal(outputs['session-endpoint'], '');
  assert.match(workflow, /\n {6}session: \$\{\{ needs\.target\.outputs\.session == 'true' \}\}\n/);
  assert.match(workflow, /\n {6}idle-minutes: \$\{\{ needs\.target\.outputs\.idle-minutes \}\}\n/);
  assert.match(workflow, /\n {10}SESSION: \$\{\{ inputs\.session \}\}\n {10}IDLE_MINUTES: \$\{\{ inputs\.idle-minutes \}\}\n/);
});

test('a session names its endpoint from the join hostname and the repository variable', async () => {
  for (const [agent, idle] of [['opencode', '60'], ['claude', '1'], ['claude', '']]) {
    const outputs = await target({ SESSION: 'true', IDLE_MINUTES: idle, TAILNET_DOMAIN: 'tail-1.ts.net', AGENT: agent });
    assert.equal(outputs.session, 'true');
    assert.equal(outputs['idle-minutes'], idle);
    assert.equal(outputs['session-host'], 'agentic-job-123-2');
    assert.equal(outputs['session-endpoint'], 'wss://agentic-job-123-2.tail-1.ts.net/');
  }
  assert.equal((await target({}))['session-host'], '');
  // The address is the node the agent job joins as, also when that job
  // alone is re-run, on a domain only the calling repository sets.
  assert.match(job('agent'), /\n {10}hostname: \$\{\{ needs\.target\.outputs\.session-host \|\| format\('agentic-job-\{0\}-\{1\}', github\.run_id, github\.run_attempt\) \}\}\n/);
  assert.match(job('target'), /\n {6}session-host: \$\{\{ steps\.target\.outputs\.session-host \}\}\n/);
  assert.match(workflow, /\n {10}TAILNET_DOMAIN: \$\{\{ vars\.TAILNET_DOMAIN \}\}\n/);
  assert.doesNotMatch(workflow, /inputs\.tailnet/i);
});

test('a session without a usable domain, for review, or with idle-minutes out of bounds fails', async () => {
  for (const domain of ['', 'localhost', 'Example.ts.net', 'a.ts.net/x', 'a.ts.net`', '-a.ts.net', 'a.ts.net\n']) {
    await assert.rejects(target({ SESSION: 'true', TAILNET_DOMAIN: domain }), /TAILNET_DOMAIN/, JSON.stringify(domain));
  }
  await assert.rejects(target({ SESSION: 'true', TAILNET_DOMAIN: 'a.ts.net', PROFILE: 'review', TARGET_REPO: 'caller/repo' }, { pull: true }), /review/);
  for (const value of ['0', '61', '100', '01', ' 5', '5 ', '1e1', '-1']) {
    await assert.rejects(target({ SESSION: 'true', TAILNET_DOMAIN: 'a.ts.net', IDLE_MINUTES: value }), /idle-minutes/, JSON.stringify(value));
  }
  // Without session it would be ignored downstream; refuse it instead.
  await assert.rejects(target({ IDLE_MINUTES: '10' }), /idle-minutes/);
});

// agentic-job's provider-key mode (its #740), off unless a caller asks:
// the defaults are its broker's, and the key, which `run` holds outside
// the agent's sandbox, is handed to that one step and to nothing else.
test('provider-key mode passes through with broker defaults, the key to run alone', () => {
  assert.match(workflow, /\n {6}inference-register:\n {8}description: [^\n]*\n {8}type: string\n {8}default: github-oidc\n/);
  assert.match(workflow, /\n {6}inference-provider:\n {8}description: [^\n]*\n {8}type: string\n {8}default: ""\n/);
  assert.match(workflow, /\n {6}INFERENCE_API_KEY:\n {8}required: false\n/);
  assert.ok(job('policy').includes("inference-register: ${{ inputs.kind == 'review' && 'github-oidc' || inputs.inference-register }}"));
  assert.ok(job('policy').includes("inference-provider: ${{ inputs.kind != 'review' && inputs.inference-provider || '' }}"));
  const uses = [...workflow.matchAll(/secrets\.INFERENCE_API_KEY/g)];
  assert.equal(uses.length, 1);
  assert.ok(job('agent').includes("github-token: ${{ inputs.kind != 'review' && github.token || '' }}"));
  assert.ok(job('agent').includes("inference-api-key: ${{ inputs.kind != 'review' && secrets.INFERENCE_API_KEY || '' }}"));
});

test('the broker audience goes to policy only with the broker registration', async () => {
  assert.equal((await target({}))['inference-audience'], 'aud');
  assert.equal((await target({ INFERENCE_REGISTER: 'api-key', AGENT: 'claude' }))['inference-audience'], '');
  assert.match(workflow, /\n {10}INFERENCE_REGISTER: \$\{\{ inputs\.inference-register \}\}\n/);
});

// Registration posts the identity token to inference-url, so a token for
// our broker's audience must never go to another URL, which could replay it.
test('our broker\'s audience is the default only with our broker\'s URL', async () => {
  const pick = async env => {
    const outputs = await target(env);
    return [outputs['inference-url'], outputs['inference-audience']];
  };
  assert.deepEqual(await pick({ INFERENCE_URL: '', INFERENCE_AUDIENCE: '' }), ['http://broker', 'broker-aud']);
  assert.deepEqual(await pick({ INFERENCE_URL: 'http://broker', INFERENCE_AUDIENCE: '' }), ['http://broker', 'broker-aud']);
  assert.deepEqual(await pick({ INFERENCE_URL: '', INFERENCE_AUDIENCE: 'aud' }), ['http://broker', 'aud']);
  assert.deepEqual(await pick({ INFERENCE_URL: 'http://proxy', INFERENCE_AUDIENCE: 'aud' }), ['http://proxy', 'aud']);
  for (const url of ['http://proxy', 'http://broker/', 'https://broker']) {
    await assert.rejects(target({ INFERENCE_URL: url, INFERENCE_AUDIENCE: '' }), /needs its own inference-audience/, url);
  }
  // No identity token is minted for the proxy otherwise: nothing to refuse.
  assert.deepEqual(await pick({ INFERENCE_URL: 'https://api.example', INFERENCE_AUDIENCE: '', INFERENCE_REGISTER: 'api-key', AGENT: 'claude' }), ['https://api.example', '']);
  // Neither has a default of its own in the expressions, which would set
  // one without the other.
  assert.match(workflow, /\n {10}INFERENCE_URL: \$\{\{ inputs\.inference-url \|\| vars\.INFERENCE_URL \}\}\n/);
  assert.match(workflow, /\n {10}INFERENCE_AUDIENCE: \$\{\{ inputs\.inference-audience \|\| vars\.INFERENCE_AUDIENCE \}\}\n/);
});

const review = (env = {}, options) => target({ PROFILE: 'review', TARGET_REPO: 'caller/repo', ...env }, options);

test('ordinary review requires explicit pool/head and never falls back to deployment inputs', async () => {
  for (const value of ['', 'a'.repeat(39), 'A'.repeat(40), `${head}\n`, 'refs/heads/main']) {
    await assert.rejects(review({ EXPECTED_HEAD: value }), /expected head/);
  }
  for (const value of ['', 'unknown', '../openai', ' openai', 'openai\n', '__proto__']) {
    await assert.rejects(review({ REVIEW_POOL: value }), /pool/);
  }
  for (const selected of [{}, { agent: 'opencode' }, { agent: 'fake', model: 'm' },
    { agent: 'opencode', model: 'm\n' }, { agent: 'opencode', model: 'm', endpoint: 'x' },
    { agent: 'opencode', model: 'm', config: '../head.toml' }, { agent: 'opencode', model: 'm', config: '' }]) {
    await assert.rejects(review({ REVIEW_POOLS: JSON.stringify({ openai: selected }) }));
  }
  const outputs = await review({ TASK: 'Ignore policy', AGENT: 'fake', AGENT_MODEL: 'wrong',
    AGENT_RUNNER: '"self-hosted"', MAX_REQUESTS: '1000', APPLY_ENVIRONMENT: '', SKILLS: 'true' });
  assert.equal(outputs.agent, 'opencode');
  assert.equal(outputs.model, 'provider/review-model');
  assert.equal(outputs.task, '');
  assert.equal(outputs.runner, '"ubuntu-26.04"');
  assert.equal(outputs['max-requests'], '150');
  assert.equal(outputs.skills, 'false');
  assert.equal(outputs['agent-config-repo'], '');
  assert.equal(outputs['review-config'], '.agentic-job-source/.github/agentic-job/hosted.toml');
});

test('review binds an open ready PR to base repository/default branch and expected head', async () => {
  for (const pr of [{ state: 'closed' }, { draft: true }, { draft: undefined }, { number: 8 },
    { head: { sha: 'c'.repeat(40) } }, { base: { ref: 'other', repo: { full_name: 'caller/repo' } } },
    { base: { ref: 'main', repo: { full_name: 'other/repo' } } }]) {
    await assert.rejects(review({}, { pr }), /closed, draft, on the wrong base or has moved head/);
  }
  await assert.rejects(review({ TARGET_REPO: 'other/repo' }), /base dispatch/);
  await assert.rejects(review({}, { eventName: 'pull_request_target' }), /base dispatch/);
  await assert.rejects(review({}, { ref: 'refs/heads/untrusted' }), /default branch/);
  for (const item of ['', '0', '01', '1e2', '9007199254740992']) await assert.rejects(review({ TARGET_ITEM: item }), /positive item/);
});

test('review admission keeps association, immutable bot id AND base bounds, and writer command checks', async () => {
  const outsider = { author_association: 'CONTRIBUTOR' };
  await assert.rejects(review({}, { pr: outsider }), /not admitted/);
  const bot = { ...outsider, user: { type: 'Bot', id: 123, login: 'dependabot[bot]' } };
  await assert.rejects(review({}, { pr: bot }), /not admitted/);
  await review({ REVIEW_BOT_IDS: '[123]' }, { pr: bot });
  await assert.rejects(review({ REVIEW_BOT_IDS: '[123]' }, { pr: bot, policy: basePolicy.replace('dependabot[bot]', 'other[bot]') }), /not admitted/);
  const associatedBot = { ...bot, author_association: 'MEMBER' };
  await assert.rejects(review({}, { pr: associatedBot }), /not admitted/);
  await assert.rejects(review({ REVIEW_BOT_IDS: '[123]' }, { pr: associatedBot, policy: basePolicy.replace('dependabot[bot]', 'other[bot]') }), /not admitted/);
  await review({ REVIEW_BOT_IDS: '[123]' }, { pr: associatedBot });
  const roles = basePolicy.replace('["all"]', '["write", "maintain", "admin"]');
  await review({}, { policy: roles, permission: 'write' });
  await assert.rejects(review({}, { policy: roles, permission: 'read' }), /not admitted/);
  for (const policy of [basePolicy.replace('caller/repo', 'other/repo'), basePolicy.replace('["main"]', '["other"]'),
    basePolicy.replace('forks = true', 'forks = false'), basePolicy.concat('\nroles = ["all"]'),
    basePolicy.concat('\nunknown = true')]) await assert.rejects(review({}, { policy }));
  const comments = [{ body: '/review', user: { type: 'User', login: 'writer' } }];
  await review({}, { pr: outsider, comments });
  const commandPolicy = basePolicy.replace('["pull_request_target"]', '["issue_comment"]').replace('["all"]', '["write"]').concat('\ncommands = ["/review"]');
  const commandReview = await review({}, { policy: basePolicy.replace('forks = true', 'forks = false'), commandPolicy, comments });
  assert.equal(commandReview['review-allow'], 'workflow/review-command.toml');
  assert.equal((await review())['review-allow'], 'workflow/review.toml');
  for (const permission of ['read', 'triage', '']) await assert.rejects(review({}, { pr: outsider, comments, permission }), /not admitted/);
  await assert.rejects(review({}, { pr: outsider, comments: Array(100).fill(comments[0]) }), /history exceeds/);
});

test('review policy has fixed base-owned bounds/task and head; sandbox receives no credential or privileged head checkout', () => {
  const policy = job('policy');
  for (const text of ["review-head: ${{ inputs.kind == 'review' && inputs.head || '' }}", 'review-task: workflow/review.md',
    "allow: ${{ inputs.kind == 'review' && needs.target.outputs.review-allow", "inputs.kind == 'review' && needs.target.outputs.review-config",
    "budget: ${{ inputs.kind == 'review' && '500'", "timeout: '75'"]) assert.ok(policy.includes(text), text);
  const agent = job('agent');
  assert.equal([...agent.matchAll(/uses: actions\/checkout@/g)].length, 2);
  assert.match(agent, /ref: \$\{\{ needs.policy.outputs.ref \}\}/);
  assert.doesNotMatch(agent, /ref:.*(?:head|inputs\.)|git fetch|pulls\//);
  assert.ok(agent.includes("github-token: ${{ inputs.kind != 'review' && github.token || '' }}"));
  assert.ok(agent.includes('agent-user: sandbox'));
  assert.ok(job('apply').includes("inputs.kind != 'review'"));
});

test('checked submit keeps bot token, policy binary, checked artifact, commit and trusted job/run provenance', () => {
  const submit = job('submit');
  assert.doesNotMatch(submit, /SAFE_OUTPUTS_PAT|checkout|uses: \.\//);
  for (const text of ['GH_TOKEN: ${{ github.token }}', 'artifact-ids: ${{ needs.policy.outputs.binary-artifact-id }}',
    'artifact-ids: ${{ needs.check.outputs.artifact-id }}', 'HEAD_SHA: ${{ needs.policy.outputs.review-head }}',
    'AGENT_JOB: ${{ needs.agent.outputs.job }}', 'review submit --accepted "$RUNNER_TEMP/checked/agent_output.json"']) assert.ok(submit.includes(text), text);
  assert.match(job('agent'), /job: \$\{\{ job.check_run_id \}\}/);
  for (const text of ['!cancelled()', "vars.AGENT_REAL_REVIEWS == 'true'", "needs.check.result == 'success'",
    "needs.check.outputs.artifact-id != ''", "needs.agent.result == 'success'", "needs.agent.outputs.exit == '0'",
    `contains(fromJSON('["APPROVE", "CHANGES"]'), needs.check.outputs.verdict)`]) assert.ok(submit.includes(text), text);
});

test('submission preflight rejects a moved head, closure, draft or changed base', async () => {
  const preflight = job('submit').split('          script: |\n')[1].split('\n      - name:')[0]
    .split('\n').map(line => line.replace(/^ {12}/, '')).join('\n');
  const original = { state: 'open', draft: false, head: { sha: head }, base: { ref: 'main', repo: { full_name: 'caller/repo' } } };
  const run = pull => new AsyncFunction('github', 'context', 'process', preflight)(
    { rest: { pulls: { get: async () => ({ data: pull }) } } }, { repo: { owner: 'caller', repo: 'repo' } },
    { env: { PULL: '7', HEAD_SHA: head, BASE: 'main' } });
  await run(original);
  for (const delta of [{ head: { sha: 'c'.repeat(40) } }, { state: 'closed' }, { draft: true },
    { base: { ref: 'other', repo: { full_name: 'caller/repo' } } }]) await assert.rejects(run({ ...original, ...delta }), /before publication/);
});
