# actions

GitHub Actions for cgwalters-forge and bootc-dev workflows, one per
directory, used as `cgwalters-forge/actions/<name>@main`. Work items are
this repository's issues.

| Action | Status | Roadmap |
| --- | --- | --- |
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

Licensed under either of [Apache-2.0](LICENSE-APACHE) or
[MIT](LICENSE-MIT), at your option.
