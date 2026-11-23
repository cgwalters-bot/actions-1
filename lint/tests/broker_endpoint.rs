//! The register jobs and the agent job join the tailnet for exactly the
//! inference URL the policy job recorded and use the address the join
//! resolved for it, or pass any URL the join does not resolve through
//! unchanged: run the actual steps offline, with a stand-in for
//! agentic-job's `config --inference-address`.

use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

use yaml_rust2::{Yaml, YamlLoader};

const ENDPOINT: &str = "The policy's inference endpoint";
const BIND: &str = "Bind the run to the joined inference endpoint";
const LITERAL: &str = "http://100.64.0.1:8080";
const NAMED: &str = "http://broker.example.ts.net:8080";
const DIRECT: &str = "https://broker.example.org";

/// (workflow, job, the steps before the endpoint whose order stays, the
/// steps that read the bound configuration)
const JOBS: [(&str, &str, &[&str], &[&str]); 4] = [
    (
        "cgwalters-agentic-job.yml",
        "register",
        &["Refuse unsupported child agents before credentials"],
        &["register"],
    ),
    (
        "cgwalters-review.yml",
        "register",
        &["Refuse unsupported child agents before credentials"],
        &["register"],
    ),
    (
        "cgwalters-review.yml",
        "prose-register",
        &["Refuse unsupported child agents before credentials"],
        &["register"],
    ),
    (
        "cgwalters-agent.yml",
        "agent",
        &[
            "Admit the runner-user configuration",
            "Refuse listening sessions on the shared runner",
            "Check the tailnet key is this attempt's and unexpired",
        ],
        &["Check inference proxy reachability", "host-config"],
    ),
];

fn workflow(file: &str) -> Yaml {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let text = fs::read_to_string(root.join(".github/workflows").join(file)).unwrap();
    YamlLoader::load_from_str(&text).unwrap().remove(0)
}

fn steps(file: &str, job: &str) -> Vec<Yaml> {
    workflow(file)["jobs"][job]["steps"]
        .as_vec()
        .unwrap()
        .clone()
}

/// The step named, with the id, or using the action LABEL.
fn position(steps: &[Yaml], label: &str) -> usize {
    steps
        .iter()
        .position(|step| {
            step["name"].as_str() == Some(label)
                || step["id"].as_str() == Some(label)
                || step["uses"].as_str().is_some_and(|u| u.starts_with(label))
        })
        .unwrap_or_else(|| panic!("no step {label}"))
}

fn env<'a>(step: &'a Yaml, key: &str) -> &'a str {
    step["env"][key]
        .as_str()
        .unwrap_or_else(|| panic!("no {key}"))
}

// The endpoint comes from the policy's configuration before the join, which
// is given it, and is bound after the join, before anything reads it; the
// preflight, admission and key checks stay before all of it.
#[test]
fn every_join_resolves_the_policy_url_and_binds_before_use() {
    let mut scripts = Vec::new();
    for (file, job, before, consumers) in JOBS {
        let steps = steps(file, job);
        let endpoint = position(&steps, ENDPOINT);
        let join = position(&steps, "cgwalters-forge/actions/tailscale@");
        let bind = position(&steps, BIND);
        let mut order: Vec<_> = before.iter().map(|s| position(&steps, s)).collect();
        order.extend([endpoint, join, bind]);
        if job != "agent" {
            // Minted after the endpoint is known good, before the join.
            order.insert(order.len() - 2, position(&steps, "minted"));
        }
        order.extend(consumers.iter().map(|s| position(&steps, s)));
        assert!(order.is_sorted(), "{file}/{job}: {order:?}");

        assert_eq!(steps[endpoint]["id"].as_str(), Some("endpoint"));
        assert_eq!(steps[join]["id"].as_str(), Some("tailnet"), "{file}/{job}");
        assert_eq!(steps[bind]["id"].as_str(), Some("bind"), "{file}/{job}");
        let with = &steps[join]["with"];
        assert_eq!(
            with["proxy"].as_str(),
            Some("${{ steps.endpoint.outputs.url }}"),
            "{file}/{job}"
        );
        assert_eq!(
            with["resolve-proxy"].as_str(),
            Some("${{ steps.endpoint.outputs.mode != 'direct' }}"),
            "{file}/{job}"
        );
        let bound = &steps[bind];
        for (key, value) in [
            ("URL", "${{ steps.endpoint.outputs.url }}"),
            ("HOST", "${{ steps.endpoint.outputs.host }}"),
            ("MODE", "${{ steps.endpoint.outputs.mode }}"),
            ("PROXY", "${{ steps.tailnet.outputs.proxy }}"),
            ("ADDRESS", "${{ steps.tailnet.outputs.proxy-address }}"),
        ] {
            assert_eq!(env(bound, key), value, "{file}/{job}");
        }
        assert_eq!(env(bound, "CONFIG"), env(&steps[endpoint], "CONFIG"));
        for consumer in consumers {
            let step = &steps[position(&steps, consumer)];
            assert_eq!(
                env(step, "CONFIG"),
                "${{ steps.bind.outputs.config }}",
                "{file}/{job}/{consumer}"
            );
            assert!(step["run"].as_str().unwrap().contains("\"$CONFIG\""));
        }
        if job == "agent" {
            // A copy, which the host's configuration and so `run` read; the
            // run's summary records the address, as prepare's input would.
            assert_eq!(env(bound, "CONFIG"), ".agentic-job/config.toml");
            assert_eq!(
                env(bound, "BOUND"),
                "${{ runner.temp }}/agentic-job-inference.toml"
            );
            assert_eq!(env(bound, "BINARY"), ".agentic-job/agentic-job");
            assert_eq!(env(bound, "META"), ".agentic-job/meta.json");
            assert_eq!(
                env(bound, "REGISTERED"),
                "${{ inputs.inference-address }}"
            );
            let input = &workflow(file)["on"]["workflow_call"]["inputs"]["inference-address"];
            assert_eq!(input["required"].as_bool(), Some(true));
        } else {
            // The address registered at, which the agent's join must find.
            assert!(bound["env"]["REGISTERED"].is_badvalue(), "{file}/{job}");
            let workflow = workflow(file);
            assert_eq!(
                workflow["jobs"][job]["outputs"]["inference-address"].as_str(),
                Some("${{ steps.bind.outputs.address }}"),
                "{file}/{job}"
            );
            let agent = if job == "register" { "agent" } else { "prose-agent" };
            assert_eq!(
                workflow["jobs"][agent]["with"]["inference-address"].as_str(),
                Some(format!("${{{{ needs.{job}.outputs.inference-address }}}}").as_str()),
                "{file}/{agent}"
            );
            // The policy upload's configuration stays as policy wrote it.
            let dir = env(&steps[position(&steps, "register")], "JOB_DIR");
            assert_eq!(env(bound, "CONFIG"), format!("{dir}/config.toml"));
            assert_eq!(env(bound, "BOUND"), format!("{dir}/register.toml"));
            assert_eq!(env(bound, "BINARY"), format!("{dir}/agentic-job"));
            assert_eq!(env(bound, "META"), "");
        }
        scripts.push((
            steps[endpoint]["run"].as_str().unwrap().to_owned(),
            bound["run"].as_str().unwrap().to_owned(),
        ));
    }
    assert!(scripts.windows(2).all(|pair| pair[0] == pair[1]));
}

fn script(name: &str) -> String {
    let steps = steps(JOBS[0].0, JOBS[0].1);
    steps[position(&steps, name)]["run"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn the_endpoint_is_an_ipv4_address_an_http_tailnet_name_or_passed_through() {
    let script = script(ENDPOINT);
    let tailnet = "broker.example.ts.net";
    let classified = |mode: &'static str| {
        move |url: &'static str, host: &'static str| {
            (
                format!("[inference]\nurl = '{url}'\nregister = 'github-oidc'"),
                Some((url, host, mode)),
            )
        }
    };
    let (direct, named) = (classified("direct"), classified("named"));
    let refused = |url: &'static str| (format!("[inference]\nurl = '{url}'"), None);
    for (config, want) in [
        (
            format!("[inference]\nurl = \"{LITERAL}\""),
            Some((LITERAL, "100.64.0.1", "literal")),
        ),
        (
            "[inference]\nurl = \"https://100.64.0.1/v1\"".into(),
            Some(("https://100.64.0.1/v1", "100.64.0.1", "literal")),
        ),
        named(NAMED, tailnet),
        // Every spelling of a tailnet name that the join's helper and
        // agentic-job accept: in any case, with a final dot, or a
        // zero-padded port.
        named("http://BROKER.example.ts.net:18080", tailnet),
        named("http://broker.example.ts.net.:18080", tailnet),
        named("http://broker.example.ts.net:018080/v1", tailnet),
        // Named too, so that the join's helper, which refuses it, fails
        // the job rather than runner DNS resolving it.
        named("http://a.ts.net..", "a.ts.net"),
        (
            "[inference]\nurl = \"http://100.64.0.1.:8080\"".into(),
            Some(("http://100.64.0.1.:8080", "100.64.0.1", "literal")),
        ),
        // Whatever the join cannot resolve or agentic-job cannot bind keeps
        // its own name, unresolved: an https name (its certificate names
        // the host), a public name, IPv6, and other plain hosts agentic-job
        // judges for itself.
        direct("https://broker.example.ts.net", tailnet),
        direct("https://Broker.Example.ORG", "broker.example.org"),
        direct("http://broker.example.com", "broker.example.com"),
        direct("http://[fd7a:115c:a1e0::1]:8080", "[fd7a:115c:a1e0::1]"),
        direct("http://100.64.0", "100.64.0"),
        direct("http://0x64.0.0.1", "0x64.0.0.1"),
        // Anything else, rather than passed through: a scheme agentic-job
        // refuses, or an authority that WHATWG URL (the tailscale action)
        // and Python's urlsplit may read as different hosts.
        refused("ftp://100.64.0.1"),
        refused("http://[::1"),
        refused("HTTP://P.TS.NET"),
        refused("http://broker%2Eexample.ts.net"),
        refused("http://evil.ts.net\\@100.64.0.1/"),
        refused("http://100.64.0.1\\@evil.ts.net/"),
        refused("http://u@100.64.0.1/"),
        refused("http://100.64.0.1?@evil.ts.net"),
        refused("http://100.64.0.1#@evil.ts.net"),
        // Nothing missing, or that would not stay one output line.
        ("[inference]\nurl = \"\"".into(), None),
        ("[inference]\nurl = 42".into(), None),
        ("[inference]\nurl = \"http://p.ts.net\\nx=y\"".into(), None),
        ("[inference]\nurl = \"http://p.ts.net/ x\"".into(), None),
        ("[agent]\nname = \"opencode\"".into(), None),
        ("inference = \"http://100.64.0.1\"".into(), None),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, &config).unwrap();
        let output = dir.path().join("output");
        fs::write(&output, "").unwrap();
        let run = Command::new("python3")
            .args(["-c", &script])
            .env("CONFIG", &path)
            .env("GITHUB_OUTPUT", &output)
            .output()
            .expect("python3");
        let stderr = String::from_utf8_lossy(&run.stderr);
        let written = fs::read_to_string(&output).unwrap();
        match want {
            Some((url, host, mode)) => {
                assert!(run.status.success(), "{config}: {stderr}");
                assert_eq!(written, format!("url={url}\nhost={host}\nmode={mode}\n"));
            }
            None => {
                assert_eq!(run.status.code(), Some(1), "{config}: {stderr}");
                assert!(stderr.contains("refused before the join"), "{stderr}");
                assert!(written.is_empty(), "{config}: {written}");
            }
        }
    }
}

#[test]
fn named_bind_requires_oidc_and_no_route_overrides_before_joining() {
    let script = script(ENDPOINT);
    for (url, register, route, mode, error) in [
        (
            NAMED,
            "github-oidc",
            "openai-url",
            "named",
            Some("inference.openai-url"),
        ),
        (
            NAMED,
            "github-oidc",
            "anthropic-url",
            "named",
            Some("inference.anthropic-url"),
        ),
        (NAMED, "plain", "", "named", Some("inference.register")),
        (LITERAL, "github-oidc", "openai-url", "literal", None),
        (DIRECT, "github-oidc", "anthropic-url", "direct", None),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let output = dir.path().join("output");
        let mut toml = format!("[inference]\nurl = '{url}'\nregister = '{register}'\n");
        if !route.is_empty() {
            toml.push_str(&format!("{route} = '{url}/provider'\n"));
        }
        fs::write(&config, &toml).unwrap();
        let result = Command::new("python3")
            .args(["-c", &script])
            .env("CONFIG", &config)
            .env("GITHUB_OUTPUT", &output)
            .output()
            .expect("python3");
        let stderr = String::from_utf8_lossy(&result.stderr);
        if let Some(error) = error {
            assert_eq!(result.status.code(), Some(1), "{toml}: {stderr}");
            assert!(
                stderr.contains(error) && stderr.contains("refused before the join"),
                "{stderr}"
            );
            assert!(!output.exists(), "{toml}");
        } else {
            assert!(result.status.success(), "{toml}: {stderr}");
            assert!(
                fs::read_to_string(output)
                    .unwrap()
                    .ends_with(&format!("\nmode={mode}\n"))
            );
        }
        assert_eq!(fs::read_to_string(config).unwrap(), toml);
    }
}

/// Stands in for agentic-job: logs its arguments, and refuses with
/// FAKE_REFUSE or prints a configuration naming the address.
const FAKE_AGENTIC_JOB: &str = r#"#!/bin/sh
printf '%s\n' "$@" > "$CALL_LOG"
[ -z "$FAKE_REFUSE" ] || { echo refused >&2; exit 1; }
echo "composed for $4"
"#;

struct Case {
    url: &'static str,
    mode: &'static str,
    proxy: &'static str,
    address: &'static str,
    refuse: bool,
    /// For the agent job alone, where its register job registered the run;
    /// unset, both kinds of job, the agent's registered at ADDRESS.
    registered: Option<&'static str>,
    /// The bound configuration, or the error's words.
    want: Result<&'static str, &'static str>,
}

const POLICY: &str = "[inference]\nurl = \"policy\"\n";

#[test]
fn binding_passes_an_ipv4_or_other_url_through_and_composes_a_name() {
    let script = script(BIND);
    let case = |url, mode, proxy, address, want| Case {
        url,
        mode,
        proxy,
        address,
        refuse: false,
        registered: None,
        want,
    };
    let cases = [
        // The deployment's case: the join passes the address through, and
        // the configuration is the policy's, byte for byte, unsubstituted.
        case(LITERAL, "literal", LITERAL, "100.64.0.1", Ok(POLICY)),
        case(
            LITERAL,
            "literal",
            LITERAL,
            "100.64.0.9",
            Err("resolved '100.64.0.9' for the address 100.64.0.1"),
        ),
        case(
            LITERAL,
            "literal",
            LITERAL,
            "",
            Err("resolved '' for the address"),
        ),
        // The join given another URL than policy's, such as the owner's default.
        case(
            LITERAL,
            "literal",
            "http://100.64.0.2:8080",
            "100.64.0.2",
            Err("not the policy inference.url"),
        ),
        case(
            LITERAL,
            "literal",
            "",
            "",
            Err("not the policy inference.url"),
        ),
        case("", "", "", "", Err("not the policy inference.url")),
        // A tailnet name: its tailnet address, through agentic-job.
        case(
            NAMED,
            "named",
            NAMED,
            "100.64.0.9",
            Ok("composed for --inference-address=100.64.0.9\n"),
        ),
        // A name the join did not resolve: no runner DNS fallback.
        case(
            NAMED,
            "named",
            NAMED,
            "",
            Err("resolved no address for broker.example.ts.net"),
        ),
        case(
            NAMED,
            "",
            NAMED,
            "100.64.0.9",
            Err("unknown inference endpoint mode ''"),
        ),
        // Any other URL: the policy's configuration, unresolved, unchanged.
        case(DIRECT, "direct", DIRECT, "", Ok(POLICY)),
        case(
            DIRECT,
            "direct",
            LITERAL,
            "",
            Err("not the policy inference.url"),
        ),
        // The endpoint step's other spellings of a name bind the same way.
        case(
            "http://BROKER.example.ts.net.:018080",
            "named",
            "http://BROKER.example.ts.net.:018080",
            "100.64.0.9",
            Ok("composed for --inference-address=100.64.0.9\n"),
        ),
        // The agent job's join must resolve where the run was registered:
        // the run token goes to no other peer, and nothing is composed.
        Case {
            registered: Some("100.64.0.8"),
            ..case(
                NAMED,
                "named",
                NAMED,
                "100.64.0.9",
                Err("not '100.64.0.8', where the run was registered"),
            )
        },
        Case {
            registered: Some(""),
            ..case(
                NAMED,
                "named",
                NAMED,
                "100.64.0.9",
                Err("resolved '100.64.0.9' for broker.example.ts.net, not ''"),
            )
        },
        Case {
            registered: Some("100.64.0.9"),
            ..case(
                DIRECT,
                "direct",
                DIRECT,
                "",
                Err("resolved '' for broker.example.org, not '100.64.0.9'"),
            )
        },
        Case {
            registered: Some(""),
            ..case(
                LITERAL,
                "literal",
                LITERAL,
                "100.64.0.1",
                Err("not '', where the run was registered"),
            )
        },
        // agentic-job's refusals (another registration, anthropic-url) fail it.
        Case {
            refuse: true,
            ..case(
                NAMED,
                "named",
                NAMED,
                "100.64.0.9",
                Err("agentic-job refused the address 100.64.0.9"),
            )
        },
    ];
    for case in cases {
        let runs = match case.registered {
            None => vec![None, Some(case.address)],
            registered => vec![registered],
        };
        for registered in runs {
            let agent = registered.is_some();
            let dir = tempfile::tempdir().unwrap();
            let config = dir.path().join("config.toml");
            fs::write(&config, POLICY).unwrap();
            let binary = dir.path().join("agentic-job");
            fs::write(&binary, FAKE_AGENTIC_JOB).unwrap();
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o644)).unwrap();
            let meta = dir.path().join("meta.json");
            fs::write(&meta, r#"{"item": "x"}"#).unwrap();
            let log = dir.path().join("calls");
            let bound = dir.path().join("bound.toml");
            let output = dir.path().join("output");
            fs::write(&output, "").unwrap();
            // The endpoint step's host for the URL.
            let host = case
                .url
                .split_once("://")
                .map_or("", |(_, rest)| rest.split([':', '/']).next().unwrap());
            let mut command = Command::new("python3");
            if let Some(registered) = registered {
                command.env("REGISTERED", registered);
            }
            let run = command
                .args(["-c", &script])
                .env("URL", case.url)
                .env("HOST", host)
                .env("MODE", case.mode)
                .env("PROXY", case.proxy)
                .env("ADDRESS", case.address)
                .env("BINARY", &binary)
                .env("CONFIG", &config)
                .env("BOUND", &bound)
                .env("META", if agent { meta.to_str().unwrap() } else { "" })
                .env("GITHUB_OUTPUT", &output)
                .env("CALL_LOG", &log)
                .env("FAKE_REFUSE", if case.refuse { "1" } else { "" })
                .output()
                .expect("python3");
            let stderr = String::from_utf8_lossy(&run.stderr);
            let label = format!("{} via {:?} (agent: {agent})", case.url, case.address);
            let written = fs::read_to_string(&output).unwrap();
            assert_eq!(fs::read_to_string(&config).unwrap(), POLICY, "{label}");
            match case.want {
                Ok(want) => {
                    assert!(run.status.success(), "{label}: {stderr}");
                    let path = if case.mode != "named" {
                        &config
                    } else {
                        &bound
                    };
                    assert_eq!(
                        written,
                        format!("config={}\naddress={}\n", path.display(), case.address)
                    );
                    assert_eq!(fs::read_to_string(path).unwrap(), want, "{label}");
                    let stdout = String::from_utf8_lossy(&run.stdout);
                    assert!(stdout.contains(case.url) && stdout.contains(case.address));
                }
                Err(words) => {
                    assert_eq!(run.status.code(), Some(1), "{label}: {stderr}");
                    assert!(stderr.contains(words), "{label}: {stderr}");
                    assert!(written.is_empty(), "{label}: {written}");
                }
            }
            let named = case.mode == "named"
                && !case.address.is_empty()
                && case.proxy == case.url
                && registered.is_none_or(|r| r == case.address);
            if named {
                assert_eq!(
                    fs::read_to_string(&log).unwrap(),
                    format!(
                        "config\n--from\n{}\n--inference-address={}\n",
                        config.display(),
                        case.address
                    ),
                    "{label}"
                );
            } else {
                assert!(!log.exists(), "{label}: a literal is never substituted");
            }
            let recorded: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&meta).unwrap()).unwrap();
            let want = if agent && named && case.want.is_ok() {
                serde_json::json!({"item": "x", "inference_address": case.address})
            } else {
                serde_json::json!({"item": "x"})
            };
            assert_eq!(recorded, want, "{label}");
        }
    }
}
