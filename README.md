# actions

GitHub Actions for cgwalters-forge and bootc-dev workflows, one per
directory, used as `cgwalters-forge/actions/<name>@main`. Work items are
this repository's issues.

| Action | Status | Roadmap |
| --- | --- | --- |
| [lint](lint/README.md) | actionlint, zizmor and the runner-label policy; this repository's CI calls it | Called from each forge repository's CI |
| [tailscale](tailscale/README.md) | Settings by organization; CI runs its unit tests and checks the socket and CLI are closed after a join that fails, no real join (no tailnet credentials here) | Replace devspace.yml's and agent.yml's tailscale/github-action steps; take over the RHEL prerequisites |

## cgwalters-agentic-job

One reusable workflow is here too:
[cgwalters-agentic-job](.github/workflows/cgwalters-agentic-job.yml), an
agent run of cgwalters-forge/agentic-job with this deployment's tailnet
join, inference proxy, runner, agent and model. Our repositories call it
at main, which is the one `job_workflow_ref` the inference broker and the
tailnet have to admit.

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

Runs may edit `.github/` here, so pull requests are reviewed by
cgwalters-forge/agentic-job's [review workflow](.github/workflows/review.yml),
called as in its `docs/review.md`, with this repository's bounds and task
in [workflow/](workflow/review.toml). The ruleset on `main` is to require its
approval, dismissed when new commits are pushed; the approval is submitted
only with the repository variable `AGENT_REAL_REVIEWS=true`, beside the
agent and inference variables its `docs/review.md` lists. Without
`.github/agentic-job/merge.toml` the reviewer is told a person approves
after it.

Licensed under either of [Apache-2.0](LICENSE-APACHE) or
[MIT](LICENSE-MIT), at your option.
