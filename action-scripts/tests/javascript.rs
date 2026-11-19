use std::{collections::BTreeSet, path::Path, process::Command};

// Existing scripts remain allowed until their pinned Rust replacement ships.
// New Node entry points would bypass the migration and its delivery checks.
const ALLOWED: &[&str] = &[
    ".github/workflows/cgwalters-agentic-job.test.mjs",
    "app-token/remint.mjs",
    "app-token/remint.test.mjs",
    "sandbox-share/share.cjs",
    "secure-host/egress-probe.mjs",
    "secure-host/read-probe.mjs",
    "tailscale/check.mjs",
    "tailscale/mint.mjs",
    "tailscale/setup.mjs",
    "tailscale/setup.test.mjs",
    // Grandfather the existing prose advisory alongside the action scripts
    // during migration; unrelated new Node entry points remain denied.
    "workflow/prose-binary.test.mjs",
    "workflow/prose.mjs",
    "workflow/prose.test.mjs",
];

#[test]
fn no_new_javascript_outside_allowlist() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let output = Command::new("git")
        .current_dir(root)
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            "*.mjs",
            "*.cjs",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "git ls-files failed");
    let paths = String::from_utf8(output.stdout).unwrap();
    let paths: BTreeSet<_> = paths.split('\0').filter(|p| !p.is_empty()).collect();
    let unexpected: BTreeSet<_> = paths.iter().filter(|p| !ALLOWED.contains(p)).collect();
    assert!(
        unexpected.is_empty(),
        "new JavaScript outside migration allowlist: {unexpected:?}"
    );
    // A deleted script must leave the allowlist, so it can't come back.
    let stale: BTreeSet<_> = ALLOWED.iter().filter(|p| !paths.contains(*p)).collect();
    assert!(
        stale.is_empty(),
        "stale migration allowlist paths: {stale:?}"
    );
}
