import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The review gate: a thin caller of this repository's cgwalters-review.yml,
// with this repository's copies of the bounds and the task, which that
// workflow reads from the base branch (agentic-job's docs/review.md,
// "Another repository").
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const caller = read('./review.yml');

// pull_request_target runs with write scopes: safe only while nothing here
// checks out or runs the head and no secret is handed down. So the caller
// is pinned whole, comments aside: one job, no steps, no secrets, and only
// the triggers and grants agentic-job's docs/review.md gives a caller. The
// `if:` admits every pull request event and `/review` comments; the called
// workflow narrows both (authors, and who may comment).
test('the caller runs nothing of the head and passes no secret', () => {
  const lines = caller.split('\n')
    .map(line => line.replace(/ # zizmor: .*$/, ''))
    .filter(line => line.trim() && !line.trim().startsWith('#'));
  assert.equal(lines.join('\n'), `name: review
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
permissions: {}
jobs:
  review:
    if: >-
      github.event_name == 'pull_request_target' ||
      (github.event.issue.pull_request && startsWith(github.event.comment.body, '/review'))
    uses: ./.github/workflows/cgwalters-review.yml
    permissions:
      contents: read
      issues: read
      pull-requests: write
      actions: read
      id-token: write
      statuses: write`);
});

// Moving main must not change privileged review code behind a caller's
// reviewed wrapper pin. Check every own-repository call, not just tailscale.
test('the review wrapper pins its own actions by full commit', () => {
  const refs = [...read('./cgwalters-review.yml').matchAll(/uses: cgwalters-forge\/actions\/(\S+)@(\S+)/g)];
  assert.deepEqual(refs.map(match => match[1]), ['admit', 'deployment', 'tailscale']);
  for (const [, action, ref] of refs) assert.match(ref, /^[0-9a-f]{40}$/, action);
});

test('the dispatch wrapper still follows main for its own actions', () => {
  const refs = [...read('./cgwalters-agentic-job.yml').matchAll(/uses: cgwalters-forge\/actions\/(\S+)@(\S+)/g)];
  assert.deepEqual(refs.map(match => [match[1], match[2]]),
    ['admit', 'deployment', 'tailscale'].map(action => [action, 'main']));
});

test('Renovate tracks all three review pins from main, without automerge or dispatch updates', () => {
  const config = JSON.parse(read('../renovate.json'));
  assert.equal(config.customManagers.length, 1);
  const manager = config.customManagers[0];
  assert.equal(manager.customType, 'regex');
  assert.deepEqual(manager.managerFilePatterns, ['/^\\.github/workflows/cgwalters-review\\.yml$/']);
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
  assert.equal([...read('./cgwalters-agentic-job.yml').matchAll(pattern)].length, 0);
  assert.deepEqual(config.packageRules, [{
    description: "Update the review wrapper's own-action commits together through review, even without release tags",
    matchManagers: ['custom.regex'], matchDatasources: ['git-refs'],
    matchPackageNames: [manager.packageNameTemplate], enabled: true,
    groupName: 'review actions', automerge: false,
  }]);
});

// From v0.5.0 check.yml's detect job asks for `id-token: write`, and GitHub
// refuses a call that grants less than a called job asks for: every run
// would fail at startup. From v0.6.2 its check job asks for `actions: read`,
// to verify the proposals upload's digest. Nothing more than that, as no
// secret goes to check.
test('both wrappers grant check exactly what its jobs ask for', () => {
  for (const file of ['./cgwalters-agentic-job.yml', './cgwalters-review.yml']) {
    const check = read(file).split('\n  check:\n')[1].split(/\n {2}[a-z-]+:\n/)[0];
    assert.match(check, /\n {4}permissions:\n {6}contents: read\n {6}actions: read\n {6}id-token: write\n {4}(?:#[^\n]*\n {4})*uses: /, file);
    assert.doesNotMatch(check, /secrets/, file);
  }
});

// A called workflow's jobs get at most what the caller grants, so the caller
// grants what the wrapper's jobs ask for, and nothing more.
test('the caller grants exactly the union of the wrapper\'s job grants', () => {
  const grants = text => [...text.matchAll(/\n {4}permissions:\n((?: {6}\S.*\n?)+)/g)]
    .flatMap(match => match[1].trim().split('\n').map(line => line.trim().split(': ')));
  const union = {};
  for (const [scope, level] of grants(read('./cgwalters-review.yml'))) {
    if (union[scope] !== 'write') union[scope] = level;
  }
  assert.deepEqual(Object.fromEntries(grants(caller)), union);
});

// checkout reads an empty `repository` as the calling repository and an
// empty `ref` as its default branch, so a job that runs the policy call's
// source checks first that policy reported the repository it calls, at a
// full commit. Every such job, so that a recomposition cannot drop it.
test('every job checks the policy call\'s source before checking it out', () => {
  for (const file of ['./cgwalters-agentic-job.yml', './cgwalters-review.yml']) {
    const workflow = read(file);
    const called = workflow.match(/\n {4}uses: ([^/\s]+\/[^/\s]+)\/\.github\/workflows\/policy\.yml@/)?.[1];
    assert.ok(called, `${file}: policy call`);
    const jobs = workflow.split(/\n {2}(?=[a-z-]+:\n)/).slice(1);
    const checked = jobs.filter(job => job.includes('repository: ${{ needs.policy.outputs.source-repository }}'));
    assert.deepEqual(checked.map(job => job.split(':')[0]), ['agent'], `${file}: jobs checking out the source`);
    for (const job of checked) {
      const name = job.split(':')[0];
      const steps = job.split(/\n {6}- /);
      const checkout = steps.findIndex(step => step.includes('repository: ${{ needs.policy.outputs.source-repository }}'));
      const guard = steps.slice(0, checkout).find(step => step.startsWith('name: The policy call\'s source repository'));
      assert.ok(guard, `${file}: ${name} checks the source first`);
      assert.match(guard, /\n {10}SOURCE_REPOSITORY: \$\{\{ needs\.policy\.outputs\.source-repository \}\}\n/, `${file}: ${name}`);
      assert.match(guard, /\n {10}SOURCE_SHA: \$\{\{ needs\.policy\.outputs\.source-sha \}\}\n/, `${file}: ${name}`);
      assert.equal(guard.match(/\n {10}EXPECTED_REPOSITORY: (\S+)\n/)?.[1], called, `${file}: ${name}`);
      assert.ok(guard.includes('[[ "$SOURCE_REPOSITORY" == "$EXPECTED_REPOSITORY" && "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||\n'
        + '            { echo "::error::the policy call is not $EXPECTED_REPOSITORY at a full commit"; exit 1; }'), `${file}: ${name}`);
    }
  }
});

test('the composed review links its pinned helper to the agent job', () => {
  const workflow = read('./cgwalters-review.yml');
  const agent = workflow.split('\n  agent:\n')[1].split('\n  check:\n')[0];
  const submit = workflow.split('\n  submit:\n')[1].split('\n  apply:\n')[0];
  assert.match(agent, /\n {6}job: \$\{\{ job\.check_run_id \}\}\n/);
  assert.match(submit, /\n {10}AGENT_JOB: \$\{\{ needs\.agent\.outputs\.job \}\}\n/);
});

// The bounds, comments aside: comment-only outputs for this repository's
// main, automatic events for any role (the shared workflow's `if:` narrows
// them to owner, members and collaborators), `/review` only from writers.
const bounds = name => read(`../../workflow/${name}.toml`)
  .split('\n').filter(line => line.trim() && !line.startsWith('#')).join('\n');
const common = repos => `hosts = ["github.com"]
repos = ${repos}
bases = ["main"]
max_outputs = 1
max_patch_bytes = 1024
max_patch_files = 1
[github.outputs]
add_comment = { max = 1 }
noop = { max = 1 }
[github.trigger]`;

test('the bounds admit one comment on this repository only', () => {
  const review = bounds('review');
  const command = bounds('review-command');
  const repos = review.match(/^repos = (\["[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+"\])$/m)?.[1];
  assert.ok(repos, 'repos names exactly one repository');
  assert.equal(review, `${common(repos)}
events = ["pull_request_target", "pull_request"]
roles = ["all"]
bots = ["dependabot[bot]"]
forks = true`);
  assert.equal(command, `${common(repos)}
events = ["issue_comment"]
roles = ["admin", "maintain", "write"]
bots = []
forks = true
commands = ["/review"]`);
});

// agentic-job's own task at the called tag, not agent-board's: that one says
// no person approves after the review, but whether one does here is the
// owner's merge policy (.github/agentic-job/merge.toml, `person` without
// it), which the run appends to the task.
test('the task treats the head as hostile and defers to the merge policy', () => {
  const task = read('../../workflow/review.md');
  for (const contract of ['hostile', 'Do not modify code', 'exact admitted head SHA', 'VERDICT: APPROVE', 'VERDICT: CHANGES', 'stated under "Merge policy"', 'Your output is only a comment']) {
    assert.ok(task.includes(contract), contract);
  }
  for (const claim of ['no person approves after you', 'the merge gate for every change here']) {
    assert.ok(!task.includes(claim), claim);
  }
});

// The review wrapper has no inputs and its caller passes no secret, so it
// stays on the broker: agentic-job's provider-key mode (its #740) is not
// wired here.
test('the review wrapper stays on the inference broker', () => {
  assert.doesNotMatch(read('./cgwalters-review.yml'), /INFERENCE_API_KEY|inference-register|inference-provider|inference-api-key/);
});
