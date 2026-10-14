//! The binary's exit codes and RUNNER_LABELS_DENY, as the Justfile runs it.

use std::path::Path;
use std::process::Command;

fn run(dir: &Path, deny: &str) -> Option<i32> {
    Command::new(env!("CARGO_BIN_EXE_runner-labels"))
        .arg(".github/workflows")
        .current_dir(dir)
        .env("RUNNER_LABELS_DENY", deny)
        .status()
        .unwrap()
        .code()
}

#[test]
fn exit_codes() {
    let dir = std::env::temp_dir().join(format!("runner-labels-cli-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    // No workflows directory: an error, not a pass.
    std::fs::create_dir_all(&dir).unwrap();
    assert_eq!(run(&dir, ""), Some(2));

    let workflows = dir.join(".github/workflows");
    std::fs::create_dir_all(&workflows).unwrap();
    std::fs::write(
        workflows.join("ci.yml"),
        "jobs:\n  a: {runs-on: ubuntu-24.04}\n",
    )
    .unwrap();
    assert_eq!(run(&dir, ""), Some(0));
    assert_eq!(run(&dir, "macos-latest, ubuntu-24.04"), Some(1));

    std::fs::write(
        workflows.join("ci.yml"),
        "jobs:\n  a: {runs-on: ubuntu-latest}\n",
    )
    .unwrap();
    assert_eq!(run(&dir, ""), Some(1));

    std::fs::write(workflows.join("ci.yml"), "jobs: [\n").unwrap();
    assert_eq!(run(&dir, ""), Some(2));
    std::fs::remove_dir_all(&dir).unwrap();
}
