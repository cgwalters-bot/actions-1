//! Review admission and publication boundaries; no live forge or tailnet calls.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use yaml_rust2::{Yaml, YamlLoader};

// The release both wrappers call, by immutable commit with its tag as a
// comment. A bump changes this, the six calls, the header and the README.
const PIN: &str = "3f9f6425119b97bb3620a38fe0adc8e79be7dc8e # v0.6.11";
const PROSE_PIN: &str = "eecc8c434e67a7607264ab3f7d90c88b6d02042a # v0.6.12";
const REVIEW: &str = ".github/workflows/cgwalters-review.yml";
const DISPATCH: &str = ".github/workflows/cgwalters-agentic-job.yml";
const LOCAL_HOST: &str = "./.agentic-job-source/secure-host";

// Moving a tag or substituting another action must not change privileged setup.
// Normalize only the validated host call so all existing assertions cover both forms.
fn host_source(text: &str, name: &str) -> String {
    let source = yaml(text);
    let hosts: Vec<_> = source["jobs"][name]["steps"]
        .as_vec()
        .unwrap()
        .iter()
        .filter(|step| {
            step["with"]["config"].as_str() == Some("${{ runner.temp }}/agentic-job-host.toml")
        })
        .collect();
    assert_eq!(hosts.len(), 1);
    let host = hosts[0]["uses"].as_str().unwrap();
    assert!(
        host == LOCAL_HOST
            || host
                .strip_prefix("cgwalters-forge/actions/secure-host@")
                .is_some_and(|sha| sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit())),
        "untrusted or mutable host reference: {host}"
    );
    text.replace(host, LOCAL_HOST)
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn read(file: &str) -> String {
    fs::read_to_string(root().join(file)).unwrap()
}

fn yaml(text: &str) -> Yaml {
    YamlLoader::load_from_str(text).unwrap().remove(0)
}

fn job<'a>(source: &'a str, name: &str) -> &'a str {
    let rest = source.split_once(&format!("\n  {name}:\n")).unwrap().1;
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.starts_with("  ")
            && !line.starts_with("   ")
            && line.trim_end().ends_with(':')
            && !line.trim_start().starts_with('#')
        {
            return &rest[..offset];
        }
        offset += line.len();
    }
    rest
}

fn includes(text: &str, expected: &[&str]) {
    for part in expected {
        assert!(text.contains(part), "missing {part:?} in {text}");
    }
}

fn excludes(text: &str, forbidden: &[&str]) {
    for part in forbidden {
        assert!(!text.contains(part), "unexpected {part:?} in {text}");
    }
}

// A deliberately small Actions-expression evaluator: parse the whole expression
// but evaluate && and || lazily, as Actions does (notably before fromJSON).
#[derive(Debug)]
enum Expr {
    Literal(Yaml),
    Path(String),
    Not(Box<Expr>),
    Binary(&'static str, Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
}

struct Parser<'a>(&'a str);

impl<'a> Parser<'a> {
    fn take(&mut self, token: &str) -> bool {
        self.0 = self.0.trim_start();
        if let Some(rest) = self.0.strip_prefix(token) {
            self.0 = rest;
            true
        } else {
            false
        }
    }

    fn expression(&mut self, level: usize) -> Expr {
        let operators: &[&'static str] = match level {
            0 => &["||"],
            1 => &["&&"],
            2 => &["==", "!="],
            _ => return self.primary(),
        };
        let mut left = self.expression(level + 1);
        loop {
            let Some(op) = operators.iter().find(|op| self.take(op)) else {
                break;
            };
            left = Expr::Binary(op, Box::new(left), Box::new(self.expression(level + 1)));
        }
        left
    }

    fn primary(&mut self) -> Expr {
        if self.take("!") {
            return Expr::Not(Box::new(self.primary()));
        }
        if self.take("(") {
            let expr = self.expression(0);
            assert!(self.take(")"));
            return expr;
        }
        if self.take("'") {
            let mut value = String::new();
            loop {
                let end = self.0.find('\'').expect("unterminated literal");
                value.push_str(&self.0[..end]);
                self.0 = &self.0[end + 1..];
                if let Some(rest) = self.0.strip_prefix('\'') {
                    value.push('\'');
                    self.0 = rest;
                } else {
                    break;
                }
            }
            return Expr::Literal(Yaml::String(value));
        }
        self.0 = self.0.trim_start();
        let end = self
            .0
            .find(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '.' && c != '-')
            .unwrap_or(self.0.len());
        assert!(end > 0, "unexpected expression: {}", self.0);
        let name = self.0[..end].to_owned();
        self.0 = &self.0[end..];
        if self.take("(") {
            let mut args = Vec::new();
            if !self.take(")") {
                loop {
                    args.push(self.expression(0));
                    if self.take(")") {
                        break;
                    }
                    assert!(self.take(","));
                }
            }
            Expr::Call(name, args)
        } else {
            match name.as_str() {
                "true" => Expr::Literal(Yaml::Boolean(true)),
                "false" => Expr::Literal(Yaml::Boolean(false)),
                "null" => Expr::Literal(Yaml::Null),
                _ if name.bytes().all(|b| b.is_ascii_digit()) => {
                    Expr::Literal(Yaml::Integer(name.parse().unwrap()))
                }
                _ => Expr::Path(name),
            }
        }
    }
}

fn truthy(value: &Yaml) -> bool {
    match value {
        Yaml::Null | Yaml::BadValue => false,
        Yaml::Boolean(b) => *b,
        Yaml::Integer(n) => *n != 0,
        Yaml::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn string(value: &Yaml) -> String {
    match value {
        Yaml::String(s) => s.to_owned(),
        Yaml::Integer(n) => n.to_string(),
        Yaml::Boolean(b) => b.to_string(),
        Yaml::Null | Yaml::BadValue => String::new(),
        _ => panic!("cannot cast {value:?} to string"),
    }
}

impl Expr {
    fn eval(&self, context: &BTreeMap<&str, Yaml>) -> Yaml {
        match self {
            Self::Literal(v) => v.clone(),
            Self::Path(path) => context.get(path.as_str()).cloned().unwrap_or(Yaml::Null),
            Self::Not(expr) => Yaml::Boolean(!truthy(&expr.eval(context))),
            Self::Binary(op, left, right) => {
                let left = left.eval(context);
                match *op {
                    "&&" if !truthy(&left) => left,
                    "||" if truthy(&left) => left,
                    "&&" | "||" => right.eval(context),
                    "==" | "!=" => {
                        let right = right.eval(context);
                        let equal = match (&left, &right) {
                            (Yaml::String(a), Yaml::String(b)) => a.eq_ignore_ascii_case(b),
                            _ => left == right,
                        };
                        Yaml::Boolean(equal == (*op == "=="))
                    }
                    _ => unreachable!(),
                }
            }
            Self::Call(name, args) => {
                let args: Vec<_> = args.iter().map(|arg| arg.eval(context)).collect();
                match (name.as_str(), args.as_slice()) {
                    ("cancelled", []) => context
                        .get("cancelled")
                        .cloned()
                        .unwrap_or(Yaml::Boolean(false)),
                    ("always", []) => Yaml::Boolean(true),
                    ("fromJSON", [value]) => yaml(&string(value)),
                    ("startsWith", [value, prefix]) => Yaml::Boolean(
                        string(value)
                            .to_ascii_lowercase()
                            .starts_with(&string(prefix).to_ascii_lowercase()),
                    ),
                    ("contains", [Yaml::Array(array), value]) => Yaml::Boolean(
                        array
                            .iter()
                            .any(|item| string(item).eq_ignore_ascii_case(&string(value))),
                    ),
                    ("contains", [Yaml::String(haystack), value]) => Yaml::Boolean(
                        haystack
                            .to_ascii_lowercase()
                            .contains(&string(value).to_ascii_lowercase()),
                    ),
                    _ => panic!("unsupported call {name}({args:?})"),
                }
            }
        }
    }
}

fn evaluate(source: &str, context: &BTreeMap<&str, Yaml>) -> bool {
    let mut parser = Parser(source);
    let expr = parser.expression(0);
    assert!(parser.0.trim().is_empty(), "unparsed: {}", parser.0);
    truthy(&expr.eval(context))
}

#[test]
fn ordinary_review_submit_fails_closed_and_never_enters_pat_apply() {
    let workflow = yaml(&read(DISPATCH));
    let condition = workflow["jobs"]["submit"]["if"].as_str().unwrap();
    let condition = condition
        .trim()
        .strip_prefix("${{")
        .unwrap()
        .strip_suffix("}}")
        .unwrap();
    let context: BTreeMap<_, _> = [
        ("inputs.kind", "review"),
        ("vars.AGENT_REAL_REVIEWS", "true"),
        ("needs.policy.outputs.review-head", "head"),
        ("needs.policy.outputs.binary-artifact-id", "123"),
        ("needs.agent.result", "success"),
        ("needs.agent.outputs.exit", "0"),
        ("needs.check.result", "success"),
        ("needs.check.outputs.artifact-id", "456"),
        ("needs.check.outputs.verdict", "APPROVE"),
    ]
    .into_iter()
    .map(|(k, v)| (k, Yaml::String(v.to_owned())))
    .collect();
    assert!(evaluate(condition, &context));
    for (key, values) in [
        (
            "inputs.kind",
            vec!["implement", "fix", "triage", "research", ""],
        ),
        ("vars.AGENT_REAL_REVIEWS", vec!["", "false"]),
        ("needs.policy.outputs.review-head", vec![""]),
        ("needs.policy.outputs.binary-artifact-id", vec![""]),
        (
            "needs.agent.result",
            vec!["failure", "cancelled", "skipped"],
        ),
        ("needs.agent.outputs.exit", vec!["", "1", "124"]),
        (
            "needs.check.result",
            vec!["failure", "cancelled", "skipped"],
        ),
        ("needs.check.outputs.artifact-id", vec![""]),
        ("needs.check.outputs.verdict", vec!["", "NOOP", "REJECT"]),
    ] {
        for value in values {
            let mut changed = context.clone();
            changed.insert(key, Yaml::String(value.to_owned()));
            assert!(!evaluate(condition, &changed), "{key}={value}");
        }
    }
    let mut changed = context.clone();
    changed.insert("cancelled", Yaml::Boolean(true));
    assert!(!evaluate(condition, &changed));
    changed = context.clone();
    changed.insert(
        "needs.check.outputs.verdict",
        Yaml::String("CHANGES".to_owned()),
    );
    assert!(evaluate(condition, &changed));
    let apply = workflow["jobs"]["apply"]["if"].as_str().unwrap();
    let apply = apply
        .trim()
        .strip_prefix("${{")
        .unwrap()
        .strip_suffix("}}")
        .unwrap();
    changed.insert("needs.policy.result", Yaml::String("success".to_owned()));
    assert!(!evaluate(apply, &changed));
    for kind in ["implement", "fix", "triage", "research"] {
        changed.insert("inputs.kind", Yaml::String(kind.to_owned()));
        assert!(evaluate(apply, &changed));
    }
}

#[test]
fn ordinary_review_privileged_dependencies_are_exclusive_literal_pins() {
    let workflow = yaml(&read(DISPATCH));
    for (job, action) in [
        ("target", "admit"),
        ("target", "deployment"),
        ("agent", "tailscale"),
    ] {
        let prefix = format!("cgwalters-forge/actions/{action}@");
        let steps: Vec<_> = workflow["jobs"][job]["steps"]
            .as_vec()
            .unwrap()
            .iter()
            .filter(|step| {
                step["uses"]
                    .as_str()
                    .is_some_and(|s| s.starts_with(&prefix))
            })
            .collect();
        assert_eq!(steps.len(), 2);
        for kind in ["review", "implement", "fix", "triage", "research"] {
            let context = BTreeMap::from([
                ("inputs.kind", Yaml::String(kind.to_owned())),
                (
                    "needs.target.outputs.agent",
                    Yaml::String("opencode".to_owned()),
                ),
            ]);
            let active: Vec<_> = steps
                .iter()
                .filter(|step| {
                    let expr = step["if"]
                        .as_str()
                        .unwrap()
                        .strip_prefix("${{")
                        .unwrap()
                        .strip_suffix("}}")
                        .unwrap();
                    evaluate(expr, &context)
                })
                .collect();
            assert_eq!(active.len(), 1, "{kind}/{action}");
            let reference = active[0]["uses"]
                .as_str()
                .unwrap()
                .strip_prefix(&prefix)
                .unwrap();
            if kind == "review" {
                assert_eq!(reference.len(), 40);
                assert!(reference.bytes().all(|b| b.is_ascii_hexdigit()));
            } else {
                assert_eq!(reference, "main");
            }
        }
    }
}

// Until policy/check/submit support the structured classifier contract, an
// ordinary verdict writer must not impersonate the consumer's reserved job.
#[test]
fn draft_classifier_writer_name_is_not_claimed_by_ordinary_workflows() {
    let reserved = "agent-board-review-result-v1";
    for entry in fs::read_dir(root().join(".github/workflows")).unwrap() {
        let path = entry.unwrap().path();
        if !matches!(
            path.extension().and_then(|s| s.to_str()),
            Some("yml" | "yaml")
        ) {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap();
        // Check the raw text too: an expression or reusable caller name must
        // not hide an ordinary writer behind this provenance contract.
        assert!(!text.contains(reserved), "{}", path.display());
    }
}

struct Event<'a> {
    association: &'a str,
    bot: bool,
    id: i64,
    ids: &'a str,
    draft: bool,
    command: Option<&'a str>,
    visibility: Option<&'a str>,
}

impl Default for Event<'_> {
    fn default() -> Self {
        Self {
            association: "NONE",
            bot: false,
            id: 42,
            ids: "",
            draft: false,
            command: None,
            visibility: Some("public"),
        }
    }
}

fn admits(event: Event<'_>) -> bool {
    let source = yaml(&read(REVIEW));
    let context = BTreeMap::from([
        (
            "github.event_name",
            Yaml::String(
                if event.command.is_some() {
                    "issue_comment"
                } else {
                    "pull_request_target"
                }
                .into(),
            ),
        ),
        (
            "github.event.pull_request.draft",
            Yaml::Boolean(event.draft),
        ),
        (
            "github.event.pull_request.author_association",
            Yaml::String(event.association.into()),
        ),
        (
            "github.event.pull_request.user.type",
            Yaml::String(if event.bot { "Bot" } else { "User" }.into()),
        ),
        ("github.event.pull_request.user.id", Yaml::Integer(event.id)),
        ("github.event.issue.pull_request", yaml("{}")),
        (
            "github.event.comment.body",
            Yaml::String(event.command.unwrap_or("").into()),
        ),
        (
            "github.event.repository.visibility",
            event
                .visibility
                .map_or(Yaml::Null, |v| Yaml::String(v.into())),
        ),
        (
            "github.event.repository.private",
            Yaml::Boolean(event.visibility != Some("public")),
        ),
        ("vars.REVIEW_BOT_IDS", Yaml::String(event.ids.into())),
    ]);
    evaluate(source["jobs"]["policy"]["if"].as_str().unwrap(), &context)
}

#[test]
fn evaluator_operators_literals_case_and_short_circuiting() {
    for (source, expected) in [
        ("'PuBlIc' == 'public' && !false", true),
        ("'Bot' != 'bot' || false", false),
        ("false && fromJSON('invalid[')", false),
        ("true || fromJSON('invalid[')", true),
        ("contains(fromJSON('[42,\"USER\"]'), '42')", true),
        ("startsWith('/REVIEW now', '/review')", true),
        ("(null || '') == '' && 42 != 0", true),
        ("contains('AbCd', 'BC')", true),
        ("'it''s' == 'IT''S'", true),
    ] {
        assert_eq!(evaluate(source, &BTreeMap::new()), expected, "{source}");
    }
}

#[test]
fn automatic_reviews_admit_trusted_associations_not_contributors_or_drafts() {
    for association in [
        "OWNER",
        "MEMBER",
        "COLLABORATOR",
        "CONTRIBUTOR",
        "FIRST_TIMER",
        "NONE",
        "owner",
    ] {
        assert_eq!(
            admits(Event {
                association,
                ..Event::default()
            }),
            ["OWNER", "MEMBER", "COLLABORATOR"]
                .iter()
                .any(|a| a.eq_ignore_ascii_case(association)),
            "{association}"
        );
        assert!(!admits(Event {
            association,
            draft: true,
            ..Event::default()
        }));
    }
}

#[test]
fn unassociated_bots_wait_unless_configured_trusted_associations_retain_admission() {
    for (bot, ids, expected) in [
        (true, "", false),
        (true, "[42]", true),
        (false, "[42]", false),
        (true, "[142]", false),
        (true, r#"["42"]"#, true),
        (true, "42", false),
    ] {
        assert_eq!(
            admits(Event {
                bot,
                ids,
                ..Event::default()
            }),
            expected,
            "{bot} {ids}"
        );
    }
    assert!(!admits(Event {
        bot: true,
        ids: "[42]",
        draft: true,
        ..Event::default()
    }));
    assert!(admits(Event {
        bot: true,
        association: "COLLABORATOR",
        ..Event::default()
    }));
}

#[test]
fn commands_reach_event_policy_retaining_bounds_and_write_role_check() {
    for (command, expected) in [
        ("/review", true),
        ("please /review", false),
        ("/REVIEW", true),
    ] {
        assert_eq!(
            admits(Event {
                command: Some(command),
                ..Event::default()
            }),
            expected
        );
    }
    let source = yaml(&read(REVIEW));
    let with = &source["jobs"]["policy"]["with"];
    assert_eq!(with["event"], Yaml::Boolean(true));
    assert!(
        with["allow"]
            .as_str()
            .unwrap()
            .contains("'workflow/review-command.toml' || 'workflow/review.toml'")
    );
    for (key, value) in [
        ("max-requests", "150"),
        ("budget", "500"),
        ("timeout", "75"),
    ] {
        assert_eq!(with[key].as_str(), Some(value));
    }
}

// Private repository opt-in remains off regardless of caller bounds.
#[test]
fn private_internal_or_missing_visibility_is_never_reviewed() {
    for visibility in [Some("private"), Some("internal"), None] {
        assert!(!admits(Event {
            association: "OWNER",
            visibility,
            ..Event::default()
        }));
        assert!(!admits(Event {
            command: Some("/review"),
            visibility,
            ..Event::default()
        }));
    }
    assert!(admits(Event {
        association: "OWNER",
        ..Event::default()
    }));
}

#[test]
fn only_admitted_agents_compete_and_only_pushes_cancel() {
    let source = yaml(&read(REVIEW));
    let agent = &source["jobs"]["agent"];
    assert_eq!(
        agent["if"].as_str(),
        Some("${{ needs.policy.outputs.admitted == 'true' }}")
    );
    assert_eq!(
        agent["concurrency"]["group"].as_str(),
        Some("review-pull-${{ github.event.pull_request.number || github.event.issue.number }}")
    );
    assert_eq!(
        agent["concurrency"]["cancel-in-progress"].as_str(),
        Some("${{ github.event_name == 'pull_request_target' }}")
    );
}

#[test]
fn trusted_source_one_network_join_before_dropping_root_no_post_agent_steps() {
    review_source(&read(REVIEW));
}

fn review_source(text: &str) {
    let text = host_source(text, "agent");
    excludes(
        &text,
        &[
            "pull_request.head",
            "head.ref",
            "secrets: inherit",
            "workflow_dispatch",
        ],
    );
    let source = yaml(&text);
    let jobs = &source["jobs"];
    let steps: Vec<_> = jobs["agent"]["steps"]
        .as_vec()
        .unwrap()
        .iter()
        .map(|step| {
            let (key, value) = step.as_hash().unwrap().iter().next().unwrap();
            assert!(["uses", "name", "id"].contains(&key.as_str().unwrap()));
            value.as_str().unwrap()
        })
        .collect();
    assert_eq!(
        steps,
        [
            "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            "The policy call's source repository",
            "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            "Create the job directory",
            "./.agentic-job-source/prepare",
            "Keep the job inputs private",
            "Join the tailnet",
            "Check inference proxy reachability",
            "The host's configuration",
            "./.agentic-job-source/secure-host",
            "run",
        ]
    );
    let agent = job(&text, "agent");
    includes(agent, &["ref: ${{ needs.policy.outputs.ref }}"]);
    excludes(
        agent,
        &[
            "pull-requests: write",
            "contents: write",
            "issues: write",
            "secrets.",
        ],
    );
    for name in ["policy", "check", "apply"] {
        includes(job(&text, name), &[&format!("/{name}.yml@{PIN}")]);
    }
    for name in jobs
        .as_hash()
        .unwrap()
        .keys()
        .map(|key| key.as_str().unwrap())
    {
        if name == "prose-agent" {
            includes(
                job(&text, name),
                &["INFERENCE_RUN_TOKEN: ${{ needs.prose-register.outputs.run-token }}"],
            );
            excludes(job(&text, name), &["secrets."]);
        } else if name != "apply" {
            excludes(job(&text, name), &["secrets."]);
        }
    }
}

#[test]
fn both_wrappers_retain_release_pins_and_check_proxy_between_join_and_setup() {
    let (sha, version) = PIN.split_once(" # v").unwrap();
    assert_eq!(sha.len(), 40);
    assert!(
        sha.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let parts: Vec<_> = version.split('.').collect();
    assert_eq!(parts.len(), 3);
    assert!(
        parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    );
    for file in [DISPATCH, REVIEW] {
        wrapper_release_and_order(&read(file));
    }
}

fn wrapper_release_and_order(text: &str) {
    let file = "wrapper fixture";
    let text = host_source(text, "agent");
    let calls: Vec<_> = text
        .lines()
        .filter_map(|line| line.trim().strip_prefix("uses: "))
        .filter(|call| {
            ["/policy.yml@", "/check.yml@", "/apply.yml@"]
                .iter()
                .any(|part| call.contains(part))
        })
        .collect();
    let has_prose = text.contains("\n  prose-policy:\n");
    assert_eq!(calls.len(), if has_prose { 6 } else { 3 }, "{file}");
    assert_eq!(
        text.matches("uses: cgwalters-forge/agentic-job/").count(),
        if has_prose { 6 } else { 3 },
        "{file}"
    );
    for (index, call) in calls.iter().enumerate() {
        assert!(call.starts_with("cgwalters-forge/agentic-job/"), "{file}");
        assert_eq!(
            call.split_once('@').unwrap().1,
            if index < 3 { PIN } else { PROSE_PIN },
            "{file}"
        );
    }
    let source = yaml(&text);
    assert_eq!(
        source["jobs"]["policy"]["permissions"]["actions"].as_str(),
        Some("read")
    );
    let agent = job(&text, "agent");
    let check = "run: agentic-job secure-host inference /var/tmp/agentic-job/config.toml";
    assert_eq!(agent.matches(check).count(), 1);
    let join = agent.find("name: Join the tailnet").unwrap();
    let inference = agent.find(check).unwrap();
    let host = agent
        .find("uses: ./.agentic-job-source/secure-host")
        .unwrap();
    let run = agent.find("uses: ./.agentic-job-source/run").unwrap();
    assert!(join < inference && inference < host && host < run, "{file}");
    excludes(agent, &["steps.secure-host.outputs.session-endpoint"]);
}

// A second user prevents the agent minting tokens using the runner's OIDC capability.
#[test]
fn both_agents_use_trusted_host_public_binary_private_inputs_and_proposals_digest() {
    for file in [DISPATCH, REVIEW] {
        wrapper_inputs(&read(file));
    }
}

fn wrapper_inputs(text: &str) {
    let text = host_source(text, "agent");
    let agent = job(&text, "agent");
    includes(
        agent,
        &[
            "run: install -d -m 0711 /var/tmp/agentic-job",
            "chmod 0600 /var/tmp/agentic-job/*\n          chmod 0755 /var/tmp/agentic-job/agentic-job",
            "run: agentic-job config --host --from /var/tmp/agentic-job/config.toml --string sandbox.env.PATH=/var/tmp/agentic-job:/usr/local/bin:/usr/bin:/bin > \"$RUNNER_TEMP/agentic-job-host.toml\"",
            "config: ${{ runner.temp }}/agentic-job-host.toml",
            "agent-user: sandbox\n",
            "\n      safe-outputs-artifact-digest: ${{ steps.run.outputs.safe-outputs-artifact-digest }}\n",
        ],
    );
    assert_eq!(agent.matches("job-dir: /var/tmp/agentic-job\n").count(), 2);
    let source = yaml(&text);
    let hosts: Vec<_> = source["jobs"]["agent"]["steps"]
        .as_vec()
        .unwrap()
        .iter()
        .filter_map(|step| step["uses"].as_str())
        .filter(|uses| uses.starts_with("./.agentic-job-source/secure-host"))
        .collect();
    assert_eq!(hosts, ["./.agentic-job-source/secure-host"]);
    excludes(
        agent,
        &["runner-home:", "--no-script", "secure-host/internal"],
    );
    includes(
        job(&text, "check"),
        &[
            "\n      safe-outputs-artifact-digest: ${{ needs.agent.outputs.safe-outputs-artifact-digest }}",
        ],
    );
}

#[test]
fn steering_receives_dispatch_item_through_policy_metadata_or_review_event() {
    let dispatch = read(DISPATCH);
    includes(
        job(&dispatch, "policy"),
        &[
            "      issue: ${{ inputs.item }}\n",
            "      output-repo: ${{ inputs.repo }}\n",
        ],
    );
    let review = read(REVIEW);
    includes(job(&review, "policy"), &["      event: true\n"]);
    for source in [&dispatch, &review] {
        excludes(source, &["watch-item:"]);
    }
}

#[test]
fn runner_smoke_uses_same_policy_binary_and_host_sequence_as_wrappers() {
    smoke_source(&read(".github/workflows/secure-host.yml"));
}

fn smoke_source(text: &str) {
    let text = host_source(text, "wrapper-sandbox");
    includes(&text, &[&format!("policy.yml@{PIN}")]);
    let policy = job(&text, "wrapper-policy");
    includes(policy, &["max-requests: '0'", "budget: '1'"]);
    assert_eq!(
        yaml(&text)["jobs"]["wrapper-policy"]["permissions"]["actions"].as_str(),
        Some("read")
    );
    let smoke = job(&text, "wrapper-sandbox");
    includes(smoke, &[&format!("ref: {PIN}")]);
    let mut previous = None;
    for step in [
        "install -d -m 0711 /var/tmp/agentic-job",
        "uses: ./.agentic-job-source/prepare",
        "job-dir: /var/tmp/agentic-job",
        "chmod 0600 /var/tmp/agentic-job/*",
        "chmod 0755 /var/tmp/agentic-job/agentic-job",
        "agentic-job secure-host inference /var/tmp/agentic-job/config.toml",
        "agentic-job config --host --from /var/tmp/agentic-job/config.toml --string sandbox.env.PATH=/var/tmp/agentic-job:/usr/local/bin:/usr/bin:/bin",
        "uses: ./.agentic-job-source/secure-host",
        "python3 workflow/sandbox-binary-check.py",
    ] {
        let index = smoke.find(step).unwrap_or_else(|| panic!("missing {step}"));
        assert!(previous.is_none_or(|p| index > p), "{step}");
        previous = Some(index);
    }
    excludes(
        smoke,
        &[
            "continue-on-error:",
            "check: false",
            "check: 'false",
            "check: \"false",
            "secrets.",
        ],
    );
    includes(
        &read("workflow/sandbox-binary-check.py"),
        &[
            "\"helper\", \"enter\"",
            "exec agentic-job --version",
            "test \"$(id -u)\" = \"$1\"",
        ],
    );
}

#[test]
fn separate_immutable_host_pin_retains_wrapper_and_smoke_contracts() {
    let direct = format!("cgwalters-forge/actions/secure-host@{}", "a".repeat(40));
    assert!(!PIN.starts_with(&"a".repeat(40)));
    for file in [DISPATCH, REVIEW, ".github/workflows/secure-host.yml"] {
        let text = read(file);
        let name = if file == ".github/workflows/secure-host.yml" {
            "wrapper-sandbox"
        } else {
            "agent"
        };
        // Also works after production has moved from the forwarder to a direct pin.
        let local = host_source(&text, name);
        let fixture = local.replace(LOCAL_HOST, &direct);
        if name == "agent" {
            wrapper_release_and_order(&fixture);
            wrapper_inputs(&fixture);
            if file == REVIEW {
                review_source(&fixture);
            }
            for call in ["policy", "check", "apply"] {
                let changed = fixture.replace(
                    &format!("/{call}.yml@{PIN}"),
                    &format!("/{call}.yml@{} # v0.6.9", "b".repeat(40)),
                );
                assert!(std::panic::catch_unwind(|| wrapper_release_and_order(&changed)).is_err());
            }
        } else {
            smoke_source(&fixture);
        }
        for invalid in [
            "cgwalters-forge/actions/secure-host@main".to_owned(),
            "cgwalters-forge/actions/secure-host@v0.6.9".to_owned(),
            format!("cgwalters-forge/actions/secure-host@{}", "a".repeat(39)),
            format!("cgwalters-forge/actions/secure-host@{}g", "a".repeat(39)),
            format!(
                "cgwalters-forge/actions/secure-host/extra@{}",
                "a".repeat(40)
            ),
            format!("other/actions/secure-host@{}", "a".repeat(40)),
            format!("{LOCAL_HOST}/extra"),
        ] {
            let changed = local.replace(LOCAL_HOST, &invalid);
            assert!(std::panic::catch_unwind(|| host_source(&changed, name)).is_err());
        }
    }
}

#[test]
fn review_bounds_scope_forge_tables_to_github() {
    for file in ["review.toml", "review-command.toml"] {
        let out = Command::new("python3")
            .args([
                "-c",
                "import json, sys, tomllib; print(json.dumps(tomllib.load(sys.stdin.buffer)))",
            ])
            .stdin(Stdio::from(
                fs::File::open(root().join("workflow").join(file)).unwrap(),
            ))
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{file}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let bounds = yaml(std::str::from_utf8(&out.stdout).unwrap());
        assert!(bounds["outputs"].is_badvalue(), "{file}");
        assert!(bounds["trigger"].is_badvalue(), "{file}");
        assert_eq!(
            bounds["github"]["outputs"],
            yaml(r#"{"add_comment":{"max":1},"noop":{"max":1}}"#),
            "{file}"
        );
        assert!(
            !bounds["github"]["trigger"]["events"]
                .as_vec()
                .unwrap()
                .is_empty(),
            "{file}"
        );
    }
}

#[test]
fn runner_probe_checks_identity_binary_execution_output_bounds_and_failures() {
    let out = Command::new("python3")
        .args(["-B", "workflow/sandbox-binary-check.test.py"])
        .current_dir(root())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn real_reviews_are_opt_in_and_use_only_checked_artifact_at_admitted_head() {
    let text = read(REVIEW);
    includes(
        job(&text, "submit"),
        &[
            "vars.AGENT_REAL_REVIEWS == 'true'",
            "needs.check.result == 'success' && needs.check.outputs.artifact-id != ''",
            "artifact-ids: ${{ needs.check.outputs.artifact-id }}",
            "HEAD_SHA: ${{ needs.policy.outputs.review-head }}",
            "review submit --accepted \"$RUNNER_TEMP/checked/agent_output.json\" --output \"$GITHUB_OUTPUT\"",
            "review-url: ${{ steps.submit.outputs.review-url }}",
        ],
    );
    let apply = yaml(&text)["jobs"]["apply"]["if"]
        .as_str()
        .unwrap()
        .to_owned();
    let cancelled = apply.find("!cancelled()").unwrap();
    assert!(cancelled < apply.find("needs.submit.outputs.review-url == ''").unwrap());
    includes(
        job(&text, "status"),
        &[
            "needs.agent.result != 'cancelled'",
            "\"$RUNNER_TEMP/bin/agentic-job\" review status",
        ],
    );
}

#[test]
fn publication_uses_policy_binary_not_removed_javascript_helpers() {
    let review = read(REVIEW);
    let dispatch = read(DISPATCH);
    let session = job(&dispatch, "session");
    for body in [
        job(&review, "refusal"),
        job(&review, "submit"),
        job(&review, "status"),
        session,
    ] {
        includes(
            body,
            &[
                "needs.policy.outputs.binary-artifact-id != ''",
                "artifact-ids: ${{ needs.policy.outputs.binary-artifact-id }}",
                "chmod +x \"$RUNNER_TEMP/bin/agentic-job\"",
            ],
        );
        excludes(body, &["actions/checkout", "actions/github-script"]);
        assert!(
            !body
                .lines()
                .any(|line| line.contains("workflow/") && line.contains(".cjs"))
        );
    }
    includes(
        job(&review, "refusal"),
        &["TEXT: ${{ needs.policy.outputs.refusal }}"],
    );
    for body in [job(&review, "refusal"), session] {
        includes(body, &["\"$RUNNER_TEMP/bin/agentic-job\" status"]);
    }
}

#[test]
fn prose_is_separate_default_off_and_uses_exact_advisory_contract() {
    let text = read(REVIEW);
    let source = yaml(&text);
    let jobs = &source["jobs"];
    for main in [
        "admit", "policy", "refusal", "agent", "check", "submit", "apply", "status",
    ] {
        excludes(
            job(&text, main),
            &["needs.prose-", "prose-pull", "REVIEW_PROSE"],
        );
    }
    includes(
        job(&text, "prose-config"),
        &[
            "needs: policy",
            "needs.policy.outputs.admitted == 'true'",
            "REVIEW_PROSE: ${{ vars.REVIEW_PROSE }}",
        ],
    );
    includes(
        job(&text, "prose-policy"),
        &[
            "needs.policy.outputs.admitted == 'true'",
            "needs.prose-config.outputs.enabled == 'true'",
        ],
    );
    let with = &jobs["prose-policy"]["with"];
    for (key, value) in [
        ("advisory", true),
        ("event", true),
        ("review", true),
        ("apply-partial", false),
    ] {
        assert_eq!(with[key], Yaml::Boolean(value), "{key}");
    }
    for (key, value) in [
        ("kind", "analysis"),
        ("outputs", "add_comment,noop"),
        ("max-outputs", "1"),
        ("notify", "none"),
        ("task", ""),
        ("review-task", "workflow/prose.md"),
        ("artifact-prefix", "prose-"),
    ] {
        assert_eq!(with[key].as_str(), Some(value), "{key}");
    }
    // The policy id does not namespace uploads. Both policy calls run in the
    // same workflow: the prefix must separate every policy/run/check artifact.
    assert!(jobs["policy"]["with"]["artifact-prefix"].is_badvalue());
    for suffix in [
        "agentic-job-binary",
        "agentic-job-policy",
        "agent-run",
        "agent-transcript",
        "safe-outputs",
        "checked-outputs",
        "applied",
    ] {
        assert_ne!(suffix, format!("prose-{suffix}"));
    }
    for key in [
        "review-item",
        "review-head",
        "comment-target",
        "output-repo",
        "item-repo",
        "apply-environment",
        "proposals-artifact",
    ] {
        assert!(with[key].is_badvalue(), "advisory forbids {key}");
    }
    for name in ["prose-policy", "prose-check", "prose-apply"] {
        assert!(
            jobs[name]["uses"]
                .as_str()
                .unwrap()
                .ends_with(PROSE_PIN.split_once(' ').unwrap().0)
        );
        excludes(
            job(&text, name),
            &[
                "SAFE_OUTPUTS_PAT",
                "statuses: write",
                "classifier",
                "verdict",
            ],
        );
    }
    includes(
        job(&text, "prose-check"),
        &[
            "safe-outputs-artifact-id: ${{ needs.prose-agent.outputs.safe-outputs-artifact-id }}",
            "safe-outputs-artifact-digest: ${{ needs.prose-agent.outputs.safe-outputs-artifact-digest }}",
        ],
    );
    includes(
        job(&text, "prose-bounds"),
        &[
            "needs.prose-check.outputs.artifact-id != ''",
            "needs.prose-check.outputs.artifact-digest",
            "digest-mismatch: error",
            "node workflow/prose.mjs check",
        ],
    );
    includes(
        job(&text, "prose-apply"),
        &[
            "needs.prose-agent.outputs.exit == '0'",
            "needs.prose-check.result == 'success'",
            "needs.prose-bounds.result == 'success'",
            "cancel-in-progress: false",
            "check: ${{ toJSON(needs.prose-check) }}",
        ],
    );
}

#[test]
fn prose_runner_only_migration_keeps_oidc_and_writes_out_of_agent_job() {
    let text = read(".github/workflows/cgwalters-prose-agent.yml");
    excludes(
        &text,
        &[
            "id-token:",
            "agent-user: sandbox",
            "pull-requests: write",
            "tailscale",
            "INFERENCE_API_KEY",
        ],
    );
    includes(
        &text,
        &[
            "eecc8c434e67a7607264ab3f7d90c88b6d02042a",
            "runner-home:",
            "AGENT_USER: runner",
            "runner-setup.py admit",
            "runner-setup.py setup",
            "inference-run-token: ${{ secrets.INFERENCE_RUN_TOKEN }}",
        ],
    );
    let source = yaml(&text);
    let steps = source["jobs"]["agent"]["steps"].as_vec().unwrap();
    let index = |part: &str| {
        steps
            .iter()
            .position(|step| format!("{step:?}").contains(part))
            .unwrap()
    };
    assert!(index("prepare") < index("runner-setup.py admit"));
    assert!(index("runner-setup.py admit") < index("node workflow/prose.mjs"));
    assert!(index("node workflow/prose.mjs") < index("config --host"));
    assert!(index("./.agentic-job-source/secure-host") < index("runner-setup.py setup"));
    assert_eq!(steps.last().unwrap()["id"].as_str(), Some("run"));
    let review = read(REVIEW);
    includes(
        job(&review, "prose-register"),
        &["id-token: write", "register --config"],
    );
    excludes(
        job(&review, "prose-agent"),
        &["id-token:", "secrets: inherit"],
    );
}

#[test]
fn prose_offline_fixtures_run_in_existing_wrapper_suite() {
    let out = Command::new("node")
        .args(["--test", "workflow/prose.test.mjs"])
        .current_dir(root())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
