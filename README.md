# actions

GitHub Actions for cgwalters-forge and bootc-dev workflows, one per
directory, used as `cgwalters-forge/actions/<name>@main`. Work items are
this repository's issues.

| Action | Status | Roadmap |
| --- | --- | --- |
| [lint](lint/README.md) | actionlint, zizmor and the runner-label policy; this repository's CI calls it | Called from each forge repository's CI |
| [workflows-check](lint/workflows-check.md) | Required workflow over a pull request's workflow files: job shape, new dangerous triggers, new zizmor ignores, checker references; CI runs its tests with fixture workflows | An organization ruleset requires it, evaluate mode first |
| [tailscale](tailscale/README.md) | Settings by organization; CI runs its unit tests and checks the socket and CLI are closed after a join that fails, no real join (no tailnet credentials here) | Replace devspace.yml's and agent.yml's tailscale/github-action steps; take over the RHEL prerequisites |

## cgwalters-agentic-job

One reusable workflow is here too:
[cgwalters-agentic-job](.github/workflows/cgwalters-agentic-job.yml), an
agent run of cgwalters-forge/agentic-job with this deployment's tailnet
join, inference proxy, runner, agent and model. Our repositories call it
at main, which is the one `job_workflow_ref` the inference broker and the
tailnet have to admit. It refuses runs from a private repository, so
agentic-job's opt-in for private repositories, which admits only the
calling repository, stays off.

A repository gets agent runs with the workflow below, a bounds file at
`.github/agentic-job/dispatch.toml` (and `fix.toml` for the `fix` kind), a
runner configuration at `.github/agentic-job/hosted.toml`, and an
environment that gates the apply token; cgwalters-forge/tracker has all four
to copy. The file's header says what else a caller may set.

```yaml
name: dispatch
run-name: ${{ inputs.kind }} ${{ inputs.repo }}#${{ inputs.item }}
on:
  workflow_dispatch:
    inputs:
      task: {type: string, required: true}
      repo: {type: string, required: true}
      item: {type: string, required: true}
      kind: {type: choice, required: true, options: [implement, triage, research, review, fix]}
permissions: {}
concurrency:
  group: dispatch-${{ inputs.kind }}-${{ inputs.repo }}-${{ inputs.item }}
jobs:
  run:
    uses: cgwalters-forge/actions/.github/workflows/cgwalters-agentic-job.yml@main
    permissions: {contents: read, issues: write, pull-requests: write, actions: read, id-token: write}
    with:
      task: ${{ inputs.task }}
      repo: ${{ inputs.repo }}
      item: ${{ inputs.item }}
      kind: ${{ inputs.kind }}
      apply-environment: agent-apply
    secrets:
      SAFE_OUTPUTS_PAT: ${{ secrets.CGWALTERS_BOT_PAT }}
```

## Review

[cgwalters-review](.github/workflows/cgwalters-review.yml) is the reusable
event-review wrapper. It composes agentic-job **v0.5.2**'s policy, check,
apply and review helpers, so that the tailnet and the inference broker admit
this file's `job_workflow_ref`; agentic-job's review workflow can now run a
caller's own network step instead (its #705), which callers have not moved
to. It refuses private repositories, as the dispatch wrapper does. It adds
our tailnet join and defaults: opencode,
`praxis/gpt-6.1-sol`, `ubuntu-26.04`, and the dispatch wrapper's inference
URL and audience. It has **no inputs**. Repository/organization variables
`AGENT`, `AGENT_MODEL`, `AGENT_RUNNER` (JSON), `INFERENCE_URL`,
`INFERENCE_AUDIENCE`, `AGENT_CONFIG`, `AGENT_CONFIG_REPO` and
`AGENT_CONFIG_PATH` select owner-controlled configuration. Set the last
two for agents needing external configuration; there is no hard-coded
configuration repository. `AGENT_CONFIG` otherwise uses the pinned
agentic-job hosted configuration.

Call it from the same `pull_request_target` and `issue_comment` events and
job condition as [this repository's caller](.github/workflows/review.yml),
replacing the job's `uses` with:

```yaml
uses: cgwalters-forge/actions/.github/workflows/cgwalters-review.yml@main
```

Keep that caller's six permission grants. Optional `SAFE_OUTPUTS_PAT` is
forwarded explicitly, only to apply; it never reaches the agent or the real
review submission. Keep `workflow/review.toml`, `workflow/review-command.toml`
and `workflow/review.md` on the caller's base branch. Automatic reviews admit
non-draft owner/member/collaborator PRs, preserving upstream's association
rule for all authors. Otherwise-unassociated bots wait unless `REVIEW_BOT_IDS`
lists their numeric IDs **and** the bounds admit their logins (including
Dependabot). Use a JSON array of numbers; Actions also coerces string IDs.
`/review` still requires write access through event policy.
Only admitted agent jobs enter per-PR concurrency; new automatic events
cancel the old agent, comments do not. The head is data inside the sandbox,
never executed by a privileged step. Each review is bounded to 150 requests,
500 AIC and 75 agent minutes.

`AGENT_REAL_REVIEWS=true` opts into checked APPROVE/REQUEST_CHANGES
submission with the job token, at the admitted head; unset is off. Enable
GitHub Actions' permission to create/approve PRs for this feature. A stale
head, cancellation or failed check cannot produce a new approval. The
compatibility `review` status is not a merge gate or human approval.

Before migrating tracker (a separate repository), admit this wrapper's
`job_workflow_ref` in the tailnet federation and inference broker, then
replace its review caller's `uses` as above and exercise a real review and
a synchronize cancellation. No ACL, OAuth or broker policy is changed here;
record those deployment changes in the private wiki when made. Removing the
deployment-specific pieces from agentic-job is a separate follow-up.
`just test-review` checks the wrapper's admission and publication boundaries;
live tailnet joins and GitHub review writes are not exercised locally.

Runs may edit `.github/` here, so pull requests are reviewed by
[this repository's caller](.github/workflows/review.yml) of the wrapper
above, referenced locally so that it runs as on the base branch, never as
a pull request edits it, with this repository's bounds and task in
[workflow/](workflow/review.toml). The ruleset on `main` is to require its
approval, dismissed when new commits are pushed; the approval is submitted
only with the repository variable `AGENT_REAL_REVIEWS=true`, beside the
variables listed above. Dependabot's pull requests are reviewed only with
its ID in `REVIEW_BOT_IDS`. Without `.github/agentic-job/merge.toml` the
reviewer is told a person approves after it.

Licensed under either of [Apache-2.0](LICENSE-APACHE) or
[MIT](LICENSE-MIT), at your option.
