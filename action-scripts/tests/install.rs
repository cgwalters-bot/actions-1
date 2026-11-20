//! install.sh against a loopback release server: it installs only a binary
//! whose SHA-256 the pin names and fails closed otherwise, and what it
//! installs runs with no Node or Rust toolchain on the PATH. CI sets
//! ACTION_SCRIPTS_ASSET to the packaged static binary; by default the test
//! binary stands in for it.
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{Arc, Mutex},
    thread,
};

const TAG: &str = "action-scripts-v0.1.0";

fn asset_name() -> String {
    format!(
        "action-scripts-{}-unknown-linux-musl",
        std::env::consts::ARCH
    )
}

fn asset() -> PathBuf {
    std::env::var_os("ACTION_SCRIPTS_ASSET").map_or_else(
        || env!("CARGO_BIN_EXE_action-scripts").into(),
        PathBuf::from,
    )
}

fn sha256(path: &Path) -> String {
    let out = Command::new("sha256sum").arg(path).output().unwrap();
    assert!(out.status.success(), "{out:?}");
    String::from_utf8(out.stdout).unwrap()[..64].to_owned()
}

/// Serves `directory` under /TAG/ and records each request's path; 404 for
/// anything else, like a release without the asset.
fn serve(directory: PathBuf, overlap: bool) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let release = format!("http://{}/{TAG}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&requests);
    thread::spawn(move || {
        let mut connections = listener.incoming();
        // In the overlap test, neither download gets a response until both
        // installers have missed the cache and started fetching.
        let first = overlap.then(|| [connections.next().unwrap(), connections.next().unwrap()]);
        for stream in first.into_iter().flatten().chain(connections) {
            // A connection curl drops is not a request; the next one is served.
            let mut stream = stream.unwrap();
            let mut reader = BufReader::new(&stream);
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            let path = line.split(' ').nth(1).unwrap_or_default().to_owned();
            loop {
                let mut header = String::new();
                if !matches!(reader.read_line(&mut header), Ok(n) if n > 0)
                    || header.trim().is_empty()
                {
                    break;
                }
            }
            seen.lock().unwrap().push(path.clone());
            let body = path
                .strip_prefix(&format!("/{TAG}/"))
                .filter(|name| !name.contains('/'))
                .and_then(|name| fs::read(directory.join(name)).ok());
            let (status, body) = match body {
                Some(body) => ("200 OK", body),
                None => ("404 Not Found", b"not found".to_vec()),
            };
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        }
    });
    (release, requests)
}

struct Installer {
    temp: tempfile::TempDir,
    release: String,
    requests: Arc<Mutex<Vec<String>>>,
    digest: String,
}

impl Installer {
    fn new() -> Self {
        Self::new_with_overlap(false)
    }

    fn new_with_overlap(overlap: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let assets = temp.path().join("assets");
        fs::create_dir(&assets).unwrap();
        fs::copy(asset(), assets.join(asset_name())).unwrap();
        let (release, requests) = serve(assets, overlap);
        let digest = sha256(&asset());
        Self {
            temp,
            release,
            requests,
            digest,
        }
    }

    fn installed(&self) -> PathBuf {
        self.runner_temp()
            .join(format!("{}-{}", asset_name(), self.digest))
    }

    fn runner_temp(&self) -> PathBuf {
        self.temp.path().join("runner-temp")
    }

    /// Runs the installer with a pin of these lines, under a PATH that
    /// starts with `uname` answering `platform` when given.
    fn run(&self, pin: Option<&str>, platform: Option<(&str, &str)>) -> Output {
        let runner_temp = self.runner_temp();
        fs::create_dir_all(&runner_temp).unwrap();
        let pin_dir = tempfile::tempdir_in(self.temp.path()).unwrap();
        let pin_path = pin_dir.path().join("release.yml");
        if let Some(pin) = pin {
            fs::write(&pin_path, pin).unwrap();
        }
        let mut path = std::env::var("PATH").unwrap();
        if let Some((system, machine)) = platform {
            let fake = self.temp.path().join("fake-bin");
            fs::create_dir_all(&fake).unwrap();
            fs::write(
                fake.join("uname"),
                format!(
                    "#!/bin/sh\ncase \"$1\" in -s) echo {system} ;; -m) echo {machine} ;; *) echo \"{system} {machine}\" ;; esac\n"
                ),
            )
            .unwrap();
            fs::set_permissions(fake.join("uname"), fs::Permissions::from_mode(0o755)).unwrap();
            path = format!("{}:{path}", fake.display());
        }
        Command::new("bash")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("install.sh"))
            .arg(&pin_path)
            .env("RUNNER_TEMP", &runner_temp)
            .env("PATH", path)
            .output()
            .unwrap()
    }

    fn pin(&self, digest: &str) -> String {
        format!(
            "release: {}\n{}: {digest}\n",
            self.release,
            std::env::consts::ARCH
        )
    }

    fn requests(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

fn assert_installed(installer: &Installer, output: &Output) {
    assert!(output.status.success(), "{output:?}");
    let bin = installer.installed();
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{}\n", bin.display())
    );
    assert_eq!(fs::metadata(&bin).unwrap().mode() & 0o7777, 0o755);
    assert_eq!(sha256(&bin), installer.digest);
}

fn assert_refused(installer: &Installer, output: &Output, message: &str) {
    assert!(!output.status.success(), "{output:?}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains(message), "{stderr}");
    assert!(output.stdout.is_empty(), "{output:?}");
    assert_eq!(
        fs::read_dir(installer.runner_temp()).unwrap().count(),
        0,
        "a failed install left files behind"
    );
}

#[test]
fn installs_the_pinned_binary_once_and_verifies_the_cached_copy() {
    let installer = Installer::new();
    let pin = installer.pin(&installer.digest);
    assert_installed(&installer, &installer.run(Some(&pin), None));
    assert_eq!(installer.requests(), 1);
    // Already there and matching: nothing is fetched again.
    assert_installed(&installer, &installer.run(Some(&pin), None));
    assert_eq!(installer.requests(), 1);
    // A copy that no longer matches is replaced, not trusted.
    fs::OpenOptions::new()
        .append(true)
        .open(installer.installed())
        .unwrap()
        .write_all(b"tampered")
        .unwrap();
    assert_installed(&installer, &installer.run(Some(&pin), None));
    assert_eq!(installer.requests(), 2);
}

#[test]
fn different_pins_keep_both_verified_paths() {
    let installer = Installer::new();
    let first = installer.run(Some(&installer.pin(&installer.digest)), None);
    assert!(first.status.success(), "{first:?}");
    let first_path = String::from_utf8(first.stdout).unwrap();

    let asset = installer.temp.path().join("assets").join(asset_name());
    fs::write(&asset, b"a different release binary").unwrap();
    let other_digest = sha256(&asset);
    let second = installer.run(Some(&installer.pin(&other_digest)), None);
    assert!(second.status.success(), "{second:?}");
    let second_path = String::from_utf8(second.stdout).unwrap();

    assert_ne!(first_path, second_path);
    assert_eq!(sha256(Path::new(first_path.trim_end())), installer.digest);
    assert_eq!(sha256(Path::new(second_path.trim_end())), other_digest);
}

#[test]
fn overlapping_installs_of_the_same_pin_both_succeed() {
    let installer = Installer::new_with_overlap(true);
    let pin = installer.pin(&installer.digest);
    let (first, second) = thread::scope(|scope| {
        let first = scope.spawn(|| installer.run(Some(&pin), None));
        let second = installer.run(Some(&pin), None);
        (first.join().unwrap(), second)
    });
    assert_installed(&installer, &first);
    assert_installed(&installer, &second);
    assert_eq!(installer.requests(), 2);
    assert_eq!(fs::read_dir(installer.runner_temp()).unwrap().count(), 1);
}

#[test]
fn refuses_a_mismatched_or_missing_asset() {
    let installer = Installer::new();
    let other = format!("{:0>64}", "1");
    assert_refused(
        &installer,
        &installer.run(Some(&installer.pin(&other)), None),
        "FAILED",
    );
    assert_eq!(installer.requests(), 1);
    // A pin whose asset no longer exists on the release host.
    let missing = installer
        .pin(&installer.digest)
        .replace(TAG, "action-scripts-v9.9.9");
    assert_refused(&installer, &installer.run(Some(&missing), None), "404");
    assert_eq!(installer.requests(), 2);
}

#[test]
fn refuses_an_unpinned_platform_before_downloading_anything() {
    let installer = Installer::new();
    let pin = installer.pin(&installer.digest);
    for (pin, platform, message) in [
        (
            Some(pin.as_str()),
            Some(("Darwin", "arm64")),
            "pins no action-scripts release for Darwin arm64",
        ),
        (
            Some(pin.as_str()),
            Some(("Linux", "riscv64")),
            "pins no action-scripts release for Linux riscv64",
        ),
        // A pin without the release URL, or without this architecture.
        (
            Some(pin.lines().nth(1).unwrap()),
            None,
            "pins no action-scripts release",
        ),
        (
            Some(pin.lines().next().unwrap()),
            None,
            "pins no action-scripts release",
        ),
        (None, None, "pins no action-scripts release"),
    ] {
        assert_refused(&installer, &installer.run(pin, platform), message);
        assert_eq!(installer.requests(), 0, "{message}");
    }
}

#[test]
fn installed_binary_needs_no_node_or_toolchain() {
    let installer = Installer::new();
    let output = installer.run(Some(&installer.pin(&installer.digest)), None);
    assert_installed(&installer, &output);
    let bin = installer.installed();
    if std::env::var_os("ACTION_SCRIPTS_ASSET").is_some() {
        let file = Command::new("file").arg(&bin).output().unwrap();
        let description = String::from_utf8_lossy(&file.stdout);
        assert!(description.contains("static"), "{description}");
    }
    // Nothing on the PATH at all: no node, cargo or shell to fall back on.
    let empty = installer.temp.path().join("empty-bin");
    fs::create_dir(&empty).unwrap();
    let settings = installer.temp.path().join("settings.json");
    let github_output = installer.temp.path().join("github-output");
    fs::write(
        &settings,
        r#"{"known":{"oauth-client-id":"client","tags":"tag:test"}}"#,
    )
    .unwrap();
    fs::write(&github_output, "").unwrap();
    let run = |args: &[&str]| {
        let mut command = Command::new(&bin);
        command
            .args(args)
            .env_clear()
            .env("PATH", &empty)
            .env("REPOSITORY_OWNER", "known")
            .env("GITHUB_OUTPUT", &github_output);
        let output = command.output().unwrap();
        assert!(output.status.success(), "{output:?}");
        String::from_utf8(output.stdout).unwrap()
    };
    assert_eq!(
        run(&["--version"]),
        format!("action-scripts {}\n", env!("CARGO_PKG_VERSION"))
    );
    run(&["tailscale-setup", settings.to_str().unwrap()]);
    assert_eq!(
        fs::read_to_string(&github_output).unwrap(),
        "oauth-client-id=client\ntags=tag:test\nproxy=\naudience=api.tailscale.com/client\n"
    );
}
