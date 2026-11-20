#!/usr/bin/env bash
# Install the pinned action-scripts release binary and print its path
# (README.md). PIN defaults to release.yml beside this script. The binary is
# refused unless its SHA-256 is the one pinned there, so neither a replaced
# release asset nor a redirected download changes what the actions run as
# root; the download's time (an attempt, and the retries in all) and size
# are bounded, so a stalled or endless one fails the job instead of hanging
# it or filling the disk.
set -euo pipefail
pin=${1:-$(dirname "$0")/release.yml}
if [ "$(uname -s)" = Linux ]; then arch=$(uname -m); else arch=none; fi
release=$(sed -n 's/^release: //p' "$pin") && sha256=$(sed -n "s/^$arch: //p" "$pin")
if [[ "$release" != *://* || ! "$sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "::error::$pin pins no action-scripts release for $(uname -sm)" >&2; exit 1
fi
asset="action-scripts-$arch-unknown-linux-musl"
bin="${RUNNER_TEMP:?}/$asset-$sha256"
if ! printf '%s  %s\n' "$sha256" "$bin" | sha256sum --check --status >/dev/null 2>&1; then
  # Another install may publish this digest, but cannot touch our staging file.
  stage=$(mktemp -- "$bin.part.XXXXXXXX")
  trap 'rm -f -- "$stage"' EXIT
  curl -fsSL --retry 3 --retry-max-time 120 --max-time 120 --max-filesize 67108864 -o "$stage" "$release/$asset"
  printf '%s  %s\n' "$sha256" "$stage" | sha256sum --check --quiet --strict >&2
  chmod 0755 "$stage"
  mv -fT -- "$stage" "$bin"
fi
echo "$bin"
