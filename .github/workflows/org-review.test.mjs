import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The organization-required review (#129): review.yml's job, pinned, and
// the ruleset that requires it.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const caller = read('./org-review.yml');

// pull_request_target runs with write scopes in every repository the
// ruleset targets: safe only while nothing here checks out or runs the head
// and no secret is handed down. So the caller is pinned whole, comments
// aside: one job, no steps, no secrets, only the events a ruleset
// workflow gets, and the wrapper at a full commit.
test('the caller runs nothing of the head and passes no secret', () => {
  const lines = caller.split('\n')
    .map(line => line.replace(/ # (zizmor: |main, ).*$/, ''))
    .filter(line => line.trim() && !line.trim().startsWith('#'));
  assert.equal(lines.join('\n').replace(/@[0-9a-f]{40}$/m, '@SHA'), `name: org-review
on:
  pull_request_target:
    types: [opened, synchronize, reopened]
permissions: {}
jobs:
  review:
    uses: cgwalters-forge/actions/.github/workflows/cgwalters-review.yml@SHA
    permissions:
      contents: read
      issues: read
      pull-requests: write
      actions: read
      id-token: write
      statuses: write`);
});

// The same grants as review.yml, which review.test.mjs holds to the
// wrapper's union, so a pin moved to a wrapper asking for more fails there.
test('the caller grants what review.yml grants', () => {
  const grants = text => text.split('\n    permissions:\n')[1].split('\n').filter(line => line.startsWith('      '));
  assert.deepEqual(grants(caller), grants(read('./review.yml')));
});

// Evaluate until the operator turns it on, for the default branch of each
// repository the operator marks as provisioned, with no bypass: a skipped
// or bypassed review is no gate.
test('the ruleset requires this workflow, in evaluate mode, with no bypass', () => {
  const ruleset = JSON.parse(read('../rulesets/org-review.json'));
  assert.equal(ruleset.enforcement, 'evaluate');
  assert.deepEqual(ruleset.bypass_actors, []);
  assert.deepEqual(Object.keys(ruleset.conditions).sort(), ['ref_name', 'repository_property']);
  assert.deepEqual(ruleset.conditions.repository_property, {
    include: [{ name: 'org-review', property_values: ['true'], source: 'custom' }],
    exclude: [],
  });
  assert.deepEqual(ruleset.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
  assert.deepEqual(ruleset.rules.map(rule => rule.type), ['workflows']);
  assert.deepEqual(ruleset.rules[0].parameters.workflows, [
    // cgwalters-forge/actions
    { path: '.github/workflows/org-review.yml', repository_id: 1393972009, ref: 'refs/heads/main' },
  ]);
});
