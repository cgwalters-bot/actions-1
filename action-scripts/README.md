# action-scripts

> This text is LLM generated.

The Rust replacements for the Node scripts of
[tailscale](../tailscale/README.md) and
[sandbox-share](../sandbox-share/README.md): one binary with a subcommand
for each (`tailscale-setup SETTINGS.json`, `tailscale-check`,
`sandbox-share`, `sandbox-share-check`). The actions still run their
scripts; CI builds and tests the binary (`just test-action-scripts`), and
checks sandbox-share's result with it.

## Delivery

A composite action runs on every caller's runner, which has no Rust
toolchain and must not build on each job. The binary is therefore a
GitHub release asset, pinned here by its SHA-256, in three parts.

[release-action-scripts.yml](../.github/workflows/release-action-scripts.yml),
run by hand on main, tags `action-scripts-vVERSION` and publishes
`action-scripts-x86_64-unknown-linux-musl`, a static binary that needs no
libc, Node or toolchain on the runner, with its `.sha256`. The hardened
build passes one checksum-verified payload to the publish job, which alone
has a write token and never executes the binary.
`just package-action-scripts` is the build it and CI run (it needs the
musl target and musl-tools).

`release.yml` beside this file, once it exists, names the release and the
binary's SHA-256 for each architecture, copied from the release's
`.sha256` asset after review:

```yaml
release: https://github.com/cgwalters-forge/actions/releases/download/action-scripts-v0.1.0
x86_64: <the asset's SHA-256>
```

[install.sh](install.sh) downloads the pinned release's binary for the
runner's architecture into `$RUNNER_TEMP`, refuses it unless its SHA-256
is the pinned one, and prints its digest-specific path. An action step can
use `bin=$(bash "$GITHUB_ACTION_PATH/../action-scripts/install.sh")`. A copy
already there is checked the same way, not trusted. Each download stages
separately and only replaces the cached copy after verification.

What each check stops: the pin, a replaced release asset or a redirected
download changing the code sandbox-share runs as root (moving a tag or
editing a release cannot move the pin, which only a reviewed change here
does); the platform check, running a binary built for another system; the
download's time (120 s for an attempt and for the retries in all) and size
(64 MiB) bounds, a stalled or endless download hanging the job or filling
the disk. The checksum is the whole trust: the installer fetches no
`.sha256` from the release, and a release made from another branch (the
workflow's own check of that is in the branch it runs from; an
`environment` on its publish job with a branch policy, a repository
setting, would enforce it) still cannot move the pin.

`tests/install.rs` runs the installer against a loopback release server:
the first install, the verified cached copy, a mismatched asset, a missing
one, unpinned platforms, and the installed binary with nothing on its
`PATH`. CI runs it a second time with the packaged static binary as the
asset (`ACTION_SCRIPTS_ASSET`), which also checks that the binary is
static.

## Cutover

Left to do, each a reviewed change here, in this order:

1. Port `tailscale/mint.mjs` to a `tailscale-mint` subcommand with the
   coverage of `lint/tests/tailscale_mint.rs`, so that one release serves
   the whole tailscale action.
2. Run the release workflow for the crate's version and add `release.yml`
   with the asset's SHA-256.
3. Switch tailscale's settings, mint and check steps and sandbox-share's
   step to `install.sh` and the binary, keeping every input, output and
   `sudo` boundary as it is; run this repository's CI, which exercises both
   actions, against the pinned release; then delete the replaced scripts
   and their entries in `tests/javascript.rs`.

The secure-host probes (`secure-host/*-probe.mjs`) are CI-only and can
move to Rust in CI, as sandbox-share's checker did, without a release.
