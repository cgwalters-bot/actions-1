import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const code = text => text.split('\n')
  .map(line => line.replace(/ # zizmor: .*$/, ''))
  .filter(line => line.trim() && !line.trim().startsWith('#'))
  .join('\n');

// pull_request_target and issues run with write scopes on input an outsider
// writes: safe only while nothing checks out, reads or runs the item. So the
// workflow is pinned whole, comments aside: one job, one API call, and only
// the item's number, never its title, body or head, in the step.
test('the reusable workflow only locks the item, by number', () => {
  assert.equal(code(read('./lock-new-items.yml')), `name: lock-new-items
on:
  workflow_call:
permissions: {}
jobs:
  lock:
    if: >-
      github.event.action == 'opened' &&
      (github.event_name == 'issues' || github.event_name == 'pull_request_target')
    runs-on: ubuntu-26.04
    timeout-minutes: 5
    permissions:
      issues: write
      pull-requests: write
    steps:
      - name: Lock the item
        env:
          GH_TOKEN: \${{ github.token }}
          REPO: \${{ github.repository }}
          ITEM: \${{ github.event.issue.number || github.event.pull_request.number }}
        run: gh api --method PUT "repos/$REPO/issues/$ITEM/lock" --silent`);
});

// The caller: the two opened events, the two grants, no secret, and the
// local reference, which resolves on the base branch.
const caller = uses => `name: lock
on:
  issues:
    types: [opened]
  pull_request_target:
    types: [opened]
permissions: {}
jobs:
  lock:
    uses: ${uses}
    permissions:
      issues: write
      pull-requests: write`;

test('this repository calls it from the base branch, with no secret', () => {
  assert.equal(code(read('./lock.yml')), caller('./.github/workflows/lock-new-items.yml'));
});

// The one file the other repositories copy is this repository's caller,
// at main.
test('the documented caller is this one, called at main', () => {
  const docs = read('../../README.md').split('\n## Lock new items\n')[1];
  const block = docs?.match(/\n```yaml\n([\s\S]*?)\n```\n/)?.[1];
  assert.ok(block, 'README.md documents the caller');
  assert.equal(code(block), caller('cgwalters-forge/actions/.github/workflows/lock-new-items.yml@main'));
});
