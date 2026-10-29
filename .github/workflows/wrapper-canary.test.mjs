import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { changesWrapper, needsCanary, problems } = require('./wrapper-canary.cjs');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const canary = read('./wrapper-canary.yml');

test('a pull request needs the canary when it changes a wrapper', () => {
  for (const [files, want] of [
    [[{ filename: '.github/workflows/cgwalters-agentic-job.yml' }], true],
    [[{ filename: 'README.md' }, { filename: '.github/workflows/cgwalters-review.yml' }], true],
    [[{ filename: '.github/workflows/old.yml', previous_filename: '.github/workflows/cgwalters-review.yml' }], true],
    [[{ filename: '.github/workflows/review.yml' }, { filename: 'admit/owners.json' }], false],
    [[], false],
  ]) {
    assert.equal(changesWrapper(files), want, JSON.stringify(files));
  }
});

test('a pull request needs the canary when the API lists only some of its files', () => {
  const files = Array.from({ length: 3000 }, (_, index) => ({ filename: `a/${index}` }));
  for (const [changed_files, want] of [[3000, false], [3001, true]]) {
    assert.equal(needsCanary({ changed_files }, files), want, `${changed_files}`);
  }
  assert.equal(needsCanary({ changed_files: 1 }, [{ filename: '.github/workflows/cgwalters-review.yml' }]), true);
});

test('a run passes only at the head, with an agent and a check that succeeded', () => {
  const workflow = 'cgwalters-forge/actions/.github/workflows/cgwalters-review.yml';
  const sha = 'a'.repeat(40);
  const run = (refSha = sha) => ({ id: 7, referenced_workflows: [
    { path: `${workflow}@wrapper-canary`, sha: refSha },
    { path: 'cgwalters-forge/agentic-job/.github/workflows/check.yml@abc', sha: 'b'.repeat(40) },
  ] });
  const jobs = (agent = 'success', check = 'success') => [
    { name: 'review / policy / policy', conclusion: 'success' },
    { name: 'review / agent', conclusion: agent },
    { name: 'review / check / check', conclusion: check },
  ];
  for (const [name, args, want] of [
    ['passes', { run: run(), jobs: jobs() }, []],
    ['another commit', { run: run('c'.repeat(40)), jobs: jobs() }, [/at c{40}, not the pull request's head a{40}/]],
    ['no call', { run: { id: 7, referenced_workflows: [] }, jobs: jobs() }, [/did not call/]],
    ['agent failed', { run: run(), jobs: jobs('failure', 'skipped') }, [/agent session .*failure/, /check of .*skipped/]],
    ['refused', { run: run(), jobs: jobs().slice(0, 1) }, [/agent session .*not run/, /check of .*not run/]],
  ]) {
    const found = problems({ ...args, workflow, job: 'review', sha });
    assert.equal(found.length, want.length, `${name}: ${found}`);
    want.forEach((pattern, index) => assert.match(found[index], pattern, name));
  }
});

// The canary's whole point: what runs is the branch a maintainer pushed
// the head they read to, and the head's files are never checked out here.
// The gate calls no workflow, which GitHub would resolve for every run.
test('only the canary calls a wrapper, at the branch, and neither checks out the head', () => {
  for (const [file, want, count] of [
    ['./wrapper-canary.yml', ['cgwalters-forge/actions/.github/workflows/cgwalters-agentic-job.yml@wrapper-canary'], 2],
    ['./wrapper-canary-gate.yml', [], 1],
  ]) {
    const text = read(file);
    assert.deepEqual([...text.matchAll(/uses: (\S+\/\.github\/workflows\/\S+)/g)].map(match => match[1]), want, file);
    assert.doesNotMatch(text, /uses: \.\//, file);
    const checkouts = text.split('- uses: actions/checkout@').slice(1).map(step => step.split(/\n {6}- /)[0]);
    assert.equal(checkouts.length, count, file);
    for (const step of checkouts) {
      assert.doesNotMatch(step, /\n {10}(?:ref|repository): (?!\$\{\{ github\.sha \}\})/, `${file}: ${step}`);
    }
  }
});

// As review.test.mjs's caller test: the dispatch call grants what the
// wrapper's jobs ask for, and nothing more.
test('the dispatch call grants exactly the union of the wrapper\'s job grants', () => {
  const grants = text => [...text.matchAll(/\n {4}permissions:\n((?: {6}\S.*\n?)+)/g)]
    .flatMap(match => match[1].trim().split('\n').map(line => line.trim().split(': ')));
  const union = {};
  for (const [scope, level] of grants(read('./cgwalters-agentic-job.yml'))) {
    if (union[scope] !== 'write') union[scope] = level;
  }
  const dispatch = canary.split('\n  dispatch:\n')[1].split(/\n {2}[a-z-]+:\n/)[0];
  assert.deepEqual(Object.fromEntries(grants(`\n${dispatch}`)), union);
});
