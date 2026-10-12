# actions

GitHub Actions for cgwalters-forge and bootc-dev workflows, one per
directory, used as `cgwalters-forge/actions/<name>@v1`. Work items are
this repository's issues.

| Action | Status | Roadmap |
| --- | --- | --- |
| [tailscale](tailscale/README.md) | Settings by organization; CI runs its unit tests and checks the socket and CLI are closed after a join that fails, no real join (no tailnet credentials here) | Replace devspace.yml's and agent.yml's tailscale/github-action steps; take over the RHEL prerequisites |

One reusable workflow is here too:
[cgwalters-agentic-job](.github/workflows/cgwalters-agentic-job.yml), an
agent run of cgwalters-forge/agentic-job with this deployment's tailnet
join, inference proxy, runner and agent defaults. Our repositories call it
at a pinned commit, which is the one `job_workflow_ref` the inference
broker and the tailnet have to admit; its header says what a caller
grants and keeps.

Licensed under either of [Apache-2.0](LICENSE-APACHE) or
[MIT](LICENSE-MIT), at your option.
