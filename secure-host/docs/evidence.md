# Evidence

> This text is LLM generated.

What has been seen to hold, where, and what has not. Taken from
agentic-job's `docs/secure-host.md` and `docs/sandbox-check.md`. Only
hosted Ubuntu 26.04 has run any of it; RHEL 10 is admitted by the image
but its runtime is unverified.

## This repository's CI

### Adoption checkpoint (2026-11-08)

Actions main at `eef41d3b216c731fda0960d6c9876a6ab3cd159a` still selects
**v0.6.9**, digest
`sha256:008d34bf9598ef83d7859772200f26637814d2cd105028457208ddc87d69788b`.
The update belongs to existing
[Dependabot #211](https://github.com/cgwalters-forge/actions/pull/211), head
`502522ad437a469da99120f89e848219434f16a7`, branch
`dependabot/docker/secure-host/cgwalters-forge/secure-host-v0.6.12`.
Continue that branch through normal follow-through/rebase and review
gates; this checkpoint neither introduces a competing bump nor merges it.

GitHub's releases API still reports
[v0.6.12](https://github.com/cgwalters-forge/agentic-job/releases/tag/v0.6.12)
as the latest numbered release, published 2026-11-06, source
`eecc8c434e67a7607264ab3f7d90c88b6d02042a`. Its published secure-host digest
in #211 is
`sha256:d5fd0f3e102c589807df68656d5623f6d6cbc9ecb257bdd3c9af431242d7b73a`.
At this checkpoint, `gh attestation verify` against that digest succeeded
with `--repo cgwalters-forge/agentic-job`, certificate identity
`https://github.com/cgwalters-forge/agentic-job/.github/workflows/release.yml@refs/heads/main`,
`--source-ref refs/heads/main` and `--deny-self-hosted-runners`.
The verified source digest is the release source above; its invocation is
[release run 42147098496, attempt 1](https://github.com/cgwalters-forge/agentic-job/actions/runs/42147098496/attempts/1).
Later `build-*` binary releases do not establish a published successor
secure-host image. No successor image pin is proposed here.

#### Published standalone binary: Ubuntu acceptance

[#211's run 42239832020](https://github.com/cgwalters-forge/actions/actions/runs/42239832020)
checked out merge revision `4fee1321fdbc729e120bbe731481f27ff9e874ea`
(head above, base `d38a1379dd1d41f84460806b05ffa90a4a5eea7c`).
The local `./secure-host` action in build and egress-policy selected the
**v0.6.12 digest above**, verified its attestation and inspected image ID
`66d5e188ca2b0a411db2b3f81e932dea9e00eaf6c8db379baa08c376ba17bc89`.
That ID, not a tag or a different action's pin, ran config and setup.

| Passed Ubuntu 26.04 job | Evidence at that revision |
| --- | --- |
| [build / 127966866848](https://github.com/cgwalters-forge/actions/actions/runs/42239832020/job/127966866848) | `config --host` via `/agentic-job`, setup installing `/usr/local/bin/secure-host` and `/usr/local/bin/agentic-job`, and 35 sandbox checks; GET allowed, POST refused by proxy, npm audit POST allowed; artifact upload |
| [egress-policy / 127966867002](https://github.com/cgwalters-forge/actions/actions/runs/42239832020/job/127966867002) | same image and 35 checks; replacement policy permits POST `/secure-host-ci` (origin 405), refuses other POST and npm audit; artifact upload |
| [publish / 127967054430](https://github.com/cgwalters-forge/actions/actions/runs/42239832020/job/127967054430) | build artifact ID `13515411164`, ZIP digest `a391689de33812461eb937d7ce672578f71584544bc18713072ab6cb91dd6e76` verified, download and commit-data validation passed |

This proves standalone-binary compatibility, not the later host-table or
core-pattern changes. Compatibility calls remain `/agentic-job config
--host` in the container and `agentic-job sandbox check` on the host.
Local regression tests cover those calls, digest selection, single-image
archive loading and setup by inspected ID. They do not attest an archive
or substitute for hosted acceptance.

#### Scripted wrapper: a separate image selection

The green `wrapper-sandbox` job in #211 used action
`c763a8950778743f51857a37b2a59daf9e96ee23`, selecting digest
`sha256:df9133ce3d7ca05c9de0c5eb7d1f6c662065288191ac857d6c877ab5833e5b49`,
not the local action or #211's v0.6.12 image. It is not v0.6.12 acceptance.

The newer scripted dispatch at actions revision
`eef41d3b216c731fda0960d6c9876a6ab3cd159a`,
[run 42488914828](https://github.com/cgwalters-forge/actions/actions/runs/42488914828),
used agentic-job source `427ce2295925654be9c35e91ca5cee91bbc2c9ea`:

- [wrapper-runner / 128756867072](https://github.com/cgwalters-forge/actions/actions/runs/42488914828/job/128756867072)
  passed prepare, runner-user admission, setup, 98 sandbox checks and
  scripted run. Its forwarder selected actions secure-host
  `466a490e983ff07e6fb076fa4bd8b4d5f918fcd6`, hence the **v0.6.9 digest**
  above. The policy binary was 0.6.12, not proof of a 0.6.12 host image.
- [wrapper-check / check / 128757099791](https://github.com/cgwalters-forge/actions/actions/runs/42488914828/job/128757099791)
  accepted the scripted handback.
- [wrapper-scripted-dispatch / 128757171343](https://github.com/cgwalters-forge/actions/actions/runs/42488914828/job/128757171343)
  passed with agent exit 0, successful check, checked artifact present,
  no refusal and no patch. No model or production dispatch was exercised.

#### Remaining gates and ownership

1. Follow through #211 rather than another image bump. Its separate
   `ci` check failed in
   [run 42239830706](https://github.com/cgwalters-forge/actions/actions/runs/42239830706);
   online zizmor reported three `ref-version-mismatch` findings for
   immutable self-pins commented `# main` (admit, deployment, tailscale).
   A green host job alone does not admit the pin. Coordinate recurring
   immutable-self-pin lint repair with
   [actions#229](https://github.com/cgwalters-forge/actions/issues/229),
   and the v0.6.12 release train
   [tracker#1369](https://github.com/cgwalters-forge/tracker/issues/1369).
2. A successor secure-host image must be published and attested from a
   source containing both host-table parsing
   [#3144](https://github.com/cgwalters-forge/agentic-job/pull/3144)
   (`420967bf3e26e64b5180e36899950b5df877fd8e`) and core protection
   [#3154](https://github.com/cgwalters-forge/agentic-job/pull/3154)
   (`773322d503987eac40845ce49d5bc0b9acbd8b30`). Neither is in v0.6.12.
   Resolve the actual published digest and verify provenance before
   updating tag and full digest together. Do not invent a v0.6.13 pin.
3. After adoption, record fresh Ubuntu setup/check, egress/artifact and
   scripted-wrapper jobs with their effective action and image selections.
   For the containing image only, require `core-pattern` plus confined
   run/JavaScript main/post controls and `confined-cleanup` orphan-process
   evidence. The upstream forced-core result below is not this acceptance.
4. Agentic-job forwarder/site pins belong to
   [#2070](https://github.com/cgwalters-forge/agentic-job/issues/2070), and
   prepare/config adoption to
   [#2656](https://github.com/cgwalters-forge/agentic-job/issues/2656).
   Leave example-plain-ci's action pin to
   [actions#226](https://github.com/cgwalters-forge/actions/issues/226)/
   [#228](https://github.com/cgwalters-forge/actions/pull/228).

RHEL 10 remains separately runtime-unverified. Skipped probes or jobs are
not acceptance. Required publication and hosted acceptance remain pending;
[actions#230](https://github.com/cgwalters-forge/actions/issues/230) is not complete.

### Workflow coverage

[The secure-host workflow](../../.github/workflows/secure-host.yml) runs
the pinned image on `ubuntu-26.04`, on every pull request and push to
main. Each job has a read-only token and no secrets and runs code as
root before the action on a fresh VM. Every claim has a positive control
before the action, a [Justfile](../../Justfile) recipe or a probe script
run with `before`, and the same check after it with `after`:

| Claim | Check | Job |
| --- | --- | --- |
| no sudo, no docker | `just secure-host-root` | `build` |
| no metadata service, while `github.com` answers | `just secure-host-metadata` | `build` |
| no read of an earlier step's process environment, which stays alive | two steps of [`secure-host.yml`](../../.github/workflows/secure-host.yml) | `build` |
| a POST refused by the proxy, a GET through | `just secure-host-egress` | `build` |
| the artifact handed over by ID with a ZIP-digest comparison and data validation | `publish` | `publish` |
| a caller's `config` is taken whole (one that keeps sudo) | `just secure-host-options` | `options` |
| an `egress-policy` file replaces the image's rules | `just secure-host-egress /secure-host-ci` | `egress-policy` |
| an invalid policy fails setup | `just secure-host-invalid-policy` | `invalid-egress-policy` |
| a root-owned mode-0666 file refuses an append after the action exits, while one of the runner's own takes it | `just secure-host-world-write` | `world-write` |

Each also passes `sandbox check` inside the action, but for `options`
and `invalid-egress-policy`, which turn it off.

The `publish` job in secure-host.yml compares upload-artifact's ZIP
digest, not the extracted file's SHA-256. It does not prove the
[README contract's](../README.md#the-contract) fixed
single-file consumer from agentic-job's
[Trusted artifact consumers](https://github.com/cgwalters-forge/agentic-job/blob/main/docs/workflows-check.md#trusted-artifact-consumers).
That contract passes one file named `artifact` by ID and file SHA-256
to a trusted data validator available without checkout or another action.
The [executable caller example](../../.github/workflows/example-plain-ci.yml)
uses standalone secure-host with `egress: write-policy` and exercises
that file-digest check and data validation with a commit ID, without
secrets or a release environment. That separate work is covered by
[#169](https://github.com/cgwalters-forge/actions/issues/169) and
[PR #171](https://github.com/cgwalters-forge/actions/pull/171).

### Acceptance recheck (2026-11-09)

Main is still `eef41d3b216c731fda0960d6c9876a6ab3cd159a`.
[#231](https://github.com/cgwalters-forge/actions/pull/231) remains open at
`5b45a813fb72e834033829589f82ce6723447178`; reuse its standalone-image
compatibility tests and v0.6.12 evidence when landed, rather than recreate
them. [Dependabot #211](https://github.com/cgwalters-forge/actions/pull/211)
still owns the image update, at `502522ad437a469da99120f89e848219434f16a7`.
The new local regression executes the action's attestation script with a
refusing verifier: no image acquisition, configuration or privileged setup
runs. A successful-verification control reaches setup; the trusted-archive
exception still reaches load without verification. This tests fail-closed
step behavior and signer arguments, not real provenance or host hardening.

The existing main [run 42488914828](https://github.com/cgwalters-forge/actions/actions/runs/42488914828)
was rechecked through job conclusions and logs, not dispatched again.
Its local `./secure-host` action selected **v0.6.9**, source
`57119eeffa17ea41b383cfdaf8370b8abeba8868`, digest
`sha256:008d34bf9598ef83d7859772200f26637814d2cd105028457208ddc87d69788b`,
inspected ID `5b7c37feafd24ceb8583ce87e0dde6d1cb65821c0e5cf86d4db8a99c20513021`.

| Passed Ubuntu 26.04 job | Rechecked result |
| --- | --- |
| [build / 128756761122](https://github.com/cgwalters-forge/actions/actions/runs/42488914828/job/128756761122) | attestation, config, setup, 98 sandbox checks and artifact upload |
| [egress-policy / 128756761255](https://github.com/cgwalters-forge/actions/actions/runs/42488914828/job/128756761255) | same image, 98 checks; POST refused, policy POST allowed (origin 405), npm audit refused by replacement policy; artifact upload |
| [publish / 128756898212](https://github.com/cgwalters-forge/actions/actions/runs/42488914828/job/128756898212) | artifact `13620478208` downloaded and ZIP digest `a93fe74a24d20aeaa0cd9408441caf9bc21b984c35d27b42a47eed76941a395f` matched; commit-data validation passed |

The same run's passed scripted-wrapper jobs and their **forwarder-selected**
action/image revisions are already recorded in #231's adoption checkpoint;
reuse that record when landed. They are not selected by `./secure-host`,
and neither those jobs nor the local old-image results above establish
containing-image acceptance.

The publication gate was checked again with GitHub's paginated releases,
release-workflow runs and `skopeo list-tags --no-creds` against
`ghcr.io/cgwalters-forge/secure-host`: there is still no numbered release or
published image beyond v0.6.12. The newer binary release
`build-2f87b8a21974f1c5552ff1225f9560cb4ad60e5cec1c4fd3446d304433fd05f9`,
source `4692b7525a07a5e8682bcdef358e9876701454a9`, does not publish an image.
Thus #231's exact publication, provenance, adoption and hosted-acceptance
prerequisites for #3144/#3154 remain outstanding. Only a containing
effective image can substantiate `core-pattern`, confined run/JavaScript
main/post and `confined-cleanup`; the source-built result below and skipped
jobs are not deployed proof. RHEL remains separately unverified and
[#230](https://github.com/cgwalters-forge/actions/issues/230) stays open.

[#229's lint repair](https://github.com/cgwalters-forge/actions/issues/229)
and [tracker#1369's release train](https://github.com/cgwalters-forge/tracker/issues/1369)
are still open; #231's ownership boundaries are unchanged. No pins or
production dispatches are changed by this recheck.

## Run-time controls through the action on hosted Ubuntu 26.04

agentic-job's CI runs its image built from the commit under test, which
can be ahead of this action's pin, through this action with
`image-archive`:

- `world-write-runtime`: after the action has exited, an append to
  setup's probe file `/etc/agentic-job/world-write-probe/file` must fail
  with "Permission denied", and a mode-0666 file of the runner's own
  takes one.
- `confined`: a probe as the runner's user before the action (the
  control, in which sudo, `docker info`, writing a root-owned mode-0666
  file in `/var/tmp`, the metadata service and the Worker's diagnostic
  sockets all work), then after it from a `run:` step and from a
  JavaScript action's main and post steps. Each route must fail, a file
  of the runner's own must still take a write, and reading the
  environment of a process an earlier step left running must fail.
  `confined-cleanup` then reads that job's log for the runner's
  `Terminate orphan process` line for that process.
- `secure-host-write-policy`: a `run:` step and a JavaScript action read
  `https://example.com/` and are refused a POST to it by the proxy, and
  the job uploads an artifact, saves and restores a cache, and ends
  green.

A hosted runner serves no IPv6 metadata address, so that refusal has a
unit test of its rule and a probe without a control, not a hosted proof.

### Forced core dumps (upstream only)

The successful Ubuntu 26.04
[confined job 42182106140/127775120020](https://github.com/cgwalters-forge/agentic-job/actions/runs/42182106140/job/127775120020)
tested the image built from PR head
`4f7fd85a9377cdeb128e7e52f5ed25d70def9481`, merged by
[#3154](https://github.com/cgwalters-forge/agentic-job/pull/3154) as
[773322d503987eac40845ce49d5bc0b9acbd8b30](https://github.com/cgwalters-forge/agentic-job/commit/773322d503987eac40845ce49d5bc0b9acbd8b30).
Its control reads a random marker from a sacrificial child's forced dump
before setup. After setup, the run step and JavaScript main and post
steps cannot recover such a dump; their records show
`core_pattern: "|/bin/false"` and `core-dump: false`. The image's
`core-pattern` check also passes. The same job records successful
pre-setup parent environ/mem/ptrace and Worker environ controls, followed
by refusals in run/main/post.

`worker-core` is derived from the sacrificial dump result and the host
pattern, **not** a direct dump of Runner.Worker or a test of its own
`prlimit`. No Worker or parent is crashed. This is existing upstream
evidence, not a new hosted reproduction, proof for the pinned image or
RHEL evidence. The host-wide setting loses every new core dump,
deterministic CI's too, but does not erase previously stored dumps.
Diagnostic sockets remain a separate route and the job remains the
trust unit; all runner-mode credential refusals stay in place.

The effective pin remains v0.6.9, without either discard or its check;
v0.6.12 also predates the fix. A release containing it and a pin update
remain [deployment #2070](https://github.com/cgwalters-forge/agentic-job/issues/2070).
[Prepare/config adoption #2656](https://github.com/cgwalters-forge/agentic-job/issues/2656)
is separate. See [runner reads](runner-reads.md#forced-core-dumps-pinned-image-versus-upstream)
for the mechanism and limits.

## Where each probe has been seen to fail

agentic-job's `tests/sandbox_host.rs` removes one protection at a time,
as root, after setup and a clean check on hosted `ubuntu-26.04`, and
requires that exactly the probes guarding it fail. It grants the
sandbox user a sudoers rule; adds it to a group; moves the polkit rule
away; opens the runner's home; puts a job variable into the system
manager's environment; takes the user off the cron and at deny lists;
switches the world-write policy off in its map (which must fail
`world-write` and `runner-world-write`); resets ptrace; starts a stopped
unit; opens listeners. For the runner's user it adds a sudoers rule
after the deny rule, a polkit rule that grants it, and starts the daemon
of a group it is in (`docker`). For the network it loads no rules, the
rules of a host with no proxy, and rules naming another uid as the
proxy's.

The test runs as the runner's user, which after setup has no root to put
anything back with, so CI starts before setup a root shell behind a
Unix socket only that user's group may connect to. It stands for what
the lock cannot close: a root process the image already runs that does
as a local user says. Nothing in a job should start one.

The first time that test ran it found a probe that passed for the wrong
reason: `pkexec` started straight from `run0` refuses because its parent
is PID 1, whatever polkit says.

What the hosted runner cannot show:

- `environ-self` and `environ-runner` rest on the kernel's own check of
  who may read `/proc/PID/environ`; there is nothing to remove, and the
  controls are all the evidence.
- It has no tailscaled and is on no tailnet; those rows passed by hand
  on a RHEL 10 runner (2026-10-07), under SELinux.
- Neither user gets an HTTP answer from the WireServer, so
  `egress-wireserver` and `egress-proxy-wireserver` have never had a
  control or been seen to fail. Its DNS port answers every user, which
  gives `egress-wireserver-dns` a control.
- It runs AppArmor, not SELinux.

## Timing

One run's step durations on hosted Ubuntu 26.04, not bounds. In
agentic-job's merge-queue
[run 38997639999](https://github.com/cgwalters-forge/agentic-job/actions/runs/38997639999/job/117294141312),
secure-host took 69 seconds, setup 48.4 and the probes 19.8; before the
world-write walk went it took 218. Loading and proving the world-write
policy takes under a second.

## RHEL 10

RHEL 10 is admitted by the image but runtime-unverified: there is no
RHEL runner for CI. Acceptance needs an operator-provisioned fresh RHEL
10 VM with root, kernel BTF and BPF privileges, never a persistent host
or a container. From a reviewed agentic-job checkout:

```sh
just world-write-test
export GITHUB_STEP_SUMMARY="$(mktemp)"
just world-write-evidence "$(mktemp -d)"
```

The summary must show every baseline, active-link, denied-write and
owner, sticky, tmpfs and overlay control passing, with kernel, package
versions, object provenance and timings. Destroy the VM afterwards, even
after a failure. The proxy's `:Z` mounts are also untested there.
