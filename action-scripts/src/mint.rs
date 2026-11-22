//! `tailscale-mint`, the port of `tailscale/mint.mjs`: mint the key a later
//! job joins with when it has no identity token. The key is what the
//! Tailscale CLI makes from a federated login itself: single-use, ephemeral
//! and preauthorized, with the tags of this job's join, and expiring. Spent
//! by that job's join, it is worth nothing to what runs after it. Neither the
//! identity token, the access token nor the key is printed, nor put in an
//! error.
use crate::tailscale::{self, Request, Response};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{env, fs, io::Write};

pub const KEY_EXPIRY_SECONDS: u64 = 3600;

/// Names the stage of a failed request, and refuses a non-2xx answer with
/// only the stage and status.
fn ok(response: Result<Response>, what: &str) -> Result<Value> {
    let response = response.context(what.to_owned())?;
    ensure!(
        (200..300).contains(&response.status),
        "{what} failed: HTTP {}",
        response.status
    );
    Ok(response.json)
}

/// The nonempty string `field` of `json`.
fn field<'a>(json: &'a Value, field: &str) -> Option<&'a str> {
    json.get(field)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
}

/// A key with a newline would write a second output line.
fn valid_key(key: &str) -> bool {
    key.strip_prefix("tskey-").is_some_and(|rest| {
        !rest.is_empty()
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

fn mint_with(
    var: impl Fn(&str) -> Option<String>,
    mut request: impl FnMut(Request<'_>) -> Result<Response>,
) -> Result<String> {
    // With step debug logging on, the runner logs each output as it is set:
    // the key would be in this job's public log, unspent.
    if var("RUNNER_DEBUG").is_some_and(|v| !v.is_empty()) {
        bail!(
            "Refusing to mint a tailnet key with step debug logging on (RUNNER_DEBUG is set): the runner would log it as it sets the output; re-run without debug logging"
        );
    }
    let tags: Vec<_> = var("TAGS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(str::to_owned)
        .collect();
    ensure!(!tags.is_empty(), "Minting a key needs the join's tags");
    let required =
        |name: &str| var(name).with_context(|| format!("missing environment variable {name}"));
    let url = tailscale::oidc_request_url(
        &required("ACTIONS_ID_TOKEN_REQUEST_URL")?,
        &required("AUDIENCE")?,
    )?;
    let token = required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")?;
    let client = required("OAUTH_CLIENT_ID")?;
    let oidc = ok(
        request(Request::Oidc { url, token: &token }),
        "Identity request",
    )?;
    let jwt = field(&oidc, "value").context("OIDC response did not include a token")?;
    let exchange = ok(
        request(Request::Exchange {
            client: &client,
            jwt,
        }),
        "Token exchange",
    )?;
    let access = field(&exchange, "access_token")
        .context("Token response did not include an access token")?;
    let body = json!({
        "capabilities": {"devices": {"create": {
            "reusable": false, "ephemeral": true, "preauthorized": true, "tags": tags,
        }}},
        "expirySeconds": KEY_EXPIRY_SECONDS,
    });
    let created = ok(
        request(Request::Key {
            token: access,
            body,
        }),
        "Key creation",
    )?;
    match field(&created, "key") {
        Some(key) if valid_key(key) => Ok(key.to_owned()),
        _ => bail!("Tailscale returned no auth key"),
    }
}

pub fn run() -> Result<()> {
    // Before minting, so that a key is never minted only to be lost.
    let output = super::required("GITHUB_OUTPUT")?;
    let client = tailscale::client()?;
    let key = mint_with(
        |name| env::var(name).ok(),
        |request| tailscale::send(&client, tailscale::API, request),
    )?;
    // Not masked: GitHub drops a job output holding a masked value. The
    // caller hands it on only as a secret of a reusable workflow call.
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(output)
        .context("open GitHub output")?;
    writeln!(file, "key={key}").context("append GitHub output")?;
    println!(
        "Minted a single-use, ephemeral key, valid for {} minutes",
        KEY_EXPIRY_SECONDS / 60
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    // Fixtures are built at run time so that no key-shaped literal is in
    // the source.
    fn fixture_key() -> String {
        format!("tskey-{}-{}", "auth", "fixture")
    }

    fn environment(overrides: &[(&str, Option<&str>)]) -> BTreeMap<String, String> {
        let mut env: BTreeMap<_, _> = [
            (
                "ACTIONS_ID_TOKEN_REQUEST_URL",
                "https://192.0.2.1/token?existing=1&audience=old",
            ),
            ("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "request-fixture"),
            ("AUDIENCE", "test-audience"),
            ("OAUTH_CLIENT_ID", "test-client"),
            ("TAGS", "tag:one, , tag:two"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        for (name, value) in overrides {
            match value {
                Some(value) => env.insert((*name).to_owned(), (*value).to_owned()),
                None => env.remove(*name),
            };
        }
        env
    }

    fn bodies() -> Vec<Value> {
        vec![
            json!({"value": "identity-fixture"}),
            json!({"scope": "auth_keys", "access_token": "access-fixture"}),
            json!({"key": fixture_key()}),
        ]
    }

    enum Reply {
        Body(Value),
        Status(u16),
        Transport,
    }

    /// Runs the mint against `replies`, one per request, recording each
    /// request it makes.
    fn exercise(
        env: &BTreeMap<String, String>,
        replies: Vec<Reply>,
    ) -> (Result<String>, Vec<String>) {
        let mut replies = replies.into_iter();
        let mut calls = Vec::new();
        let result = mint_with(
            |name| env.get(name).cloned(),
            |request| {
                calls.push(match request {
                    Request::Oidc { url, token } => format!("oidc {url} {token}"),
                    Request::Exchange { client, jwt } => format!("exchange {client} {jwt}"),
                    Request::Key { token, body } => format!("key {token} {body}"),
                    Request::Probe(_) => panic!("the mint probes nothing"),
                });
                match replies.next().expect("unexpected request") {
                    Reply::Body(json) => Ok(Response { status: 200, json }),
                    Reply::Status(status) => Ok(Response {
                        status,
                        json: Value::Null,
                    }),
                    Reply::Transport => bail!("network unavailable"),
                }
            },
        );
        (result, calls)
    }

    fn replies() -> Vec<Reply> {
        bodies().into_iter().map(Reply::Body).collect()
    }

    fn assert_failure((result, calls): (Result<String>, Vec<String>), message: &str, count: usize) {
        let error = format!("{:#}", result.unwrap_err());
        assert!(error.contains(message), "{error}");
        assert_eq!(calls.len(), count, "{calls:?}");
        for secret in ["request-fixture", "identity-fixture", "access-fixture"] {
            assert!(!error.contains(secret), "{error}");
        }
    }

    #[test]
    fn requests_a_single_use_ephemeral_key() {
        let (key, calls) = exercise(&environment(&[]), replies());
        assert_eq!(key.unwrap(), fixture_key());
        let body = json!({
            "capabilities": {"devices": {"create": {
                "reusable": false, "ephemeral": true, "preauthorized": true,
                "tags": ["tag:one", "tag:two"],
            }}},
            "expirySeconds": 3600,
        });
        assert_eq!(
            calls,
            [
                "oidc https://192.0.2.1/token?existing=1&audience=test-audience request-fixture"
                    .to_owned(),
                "exchange test-client identity-fixture".to_owned(),
                format!("key access-fixture {body}"),
            ]
        );
    }

    #[test]
    fn invalid_environment_is_refused_before_requesting_credentials() {
        for (overrides, message) in [
            (vec![("RUNNER_DEBUG", Some("1"))], "debug logging"),
            (vec![("RUNNER_DEBUG", Some("0"))], "debug logging"),
            (vec![("TAGS", Some(" , "))], "tags"),
            (vec![("TAGS", None)], "tags"),
            (vec![("AUDIENCE", None)], "AUDIENCE"),
            (vec![("OAUTH_CLIENT_ID", None)], "OAUTH_CLIENT_ID"),
        ] {
            assert_failure(exercise(&environment(&overrides), replies()), message, 0);
        }
        // An empty RUNNER_DEBUG is off, as in the runner.
        let env = environment(&[("RUNNER_DEBUG", Some(""))]);
        assert!(exercise(&env, replies()).0.is_ok());
    }

    #[test]
    fn http_and_transport_failures_stop_at_each_stage() {
        for (stage, label, status) in [
            (0, "Identity request", 403),
            (1, "Token exchange", 401),
            (2, "Key creation", 403),
        ] {
            for (reply, message) in [
                (
                    Reply::Status(status),
                    format!("{label} failed: HTTP {status}"),
                ),
                (Reply::Status(302), format!("{label} failed: HTTP 302")),
                (Reply::Transport, "network unavailable".into()),
            ] {
                let mut replies = replies();
                replies[stage] = reply;
                assert_failure(exercise(&environment(&[]), replies), &message, stage + 1);
            }
        }
    }

    #[test]
    fn missing_or_malformed_credentials_never_advance_to_the_next_stage() {
        for (stage, name, message) in [
            (0, "value", "did not include a token"),
            (1, "access_token", "access token"),
            (2, "key", "no auth key"),
        ] {
            let mut bodies = vec![json!({})];
            for value in [Value::Null, json!(false), json!(42), json!(""), json!([])] {
                bodies.push(json!({name: value}));
            }
            if stage == 2 {
                for suffix in ["a\nb=c", "", "a\r", "a ", "a/b"] {
                    bodies.push(json!({name: format!("tskey-{suffix}")}));
                }
                bodies.push(json!({name: "not-a-key"}));
            }
            for body in bodies {
                let mut replies = replies();
                replies[stage] = Reply::Body(body);
                assert_failure(exercise(&environment(&[]), replies), message, stage + 1);
            }
        }
    }

    #[test]
    fn mint_over_http() {
        let ok = |json: Value| (200, json.to_string().into_bytes());
        let [oidc, exchange, created]: [_; 3] = bodies()
            .into_iter()
            .map(ok)
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();
        for (responses, error) in [
            (vec![oidc.clone(), exchange.clone(), created], ""),
            // A redirect is not followed: the server would see a fourth request.
            (
                vec![oidc.clone(), exchange.clone(), (307, vec![])],
                "Key creation failed: HTTP 307",
            ),
            (vec![(200, b"not json".to_vec())], "Identity request"),
            (
                vec![oidc.clone(), (200, b"not json".to_vec())],
                "Token exchange: decode identity response",
            ),
            (
                vec![oidc.clone(), exchange.clone(), (200, b"not json".to_vec())],
                "Key creation: decode identity response",
            ),
        ] {
            let count = responses.len();
            let (base, server) = tailscale::tests::serve(responses);
            let env = environment(&[(
                "ACTIONS_ID_TOKEN_REQUEST_URL",
                Some(&format!("{base}/token?existing=1&audience=old")),
            )]);
            let client = tailscale::client().unwrap();
            let result = mint_with(
                |name| env.get(name).cloned(),
                |request| tailscale::send(&client, &base, request),
            );
            let requests = server.join().unwrap();
            assert_eq!(requests.len(), count);
            let first = requests[0].to_ascii_lowercase();
            assert!(first.starts_with("get /token?existing=1&audience=test-audience http/1.1\r\n"));
            assert!(first.contains("\r\nauthorization: bearer request-fixture\r\n"));
            if let Some(exchange) = requests.get(1) {
                assert!(exchange.starts_with("POST /oauth/token-exchange HTTP/1.1\r\n"));
                assert!(exchange.ends_with("\r\n\r\nclient_id=test-client&jwt=identity-fixture"));
            }
            if let Some(key) = requests.get(2) {
                let lower = key.to_ascii_lowercase();
                assert!(key.starts_with("POST /tailnet/-/keys HTTP/1.1\r\n"));
                assert!(lower.contains("\r\nauthorization: bearer access-fixture\r\n"));
                assert!(lower.contains("\r\ncontent-type: application/json\r\n"));
                let (_, body) = key.split_once("\r\n\r\n").unwrap();
                let body: Value = serde_json::from_str(body).unwrap();
                assert_eq!(body["expirySeconds"], 3600);
                assert_eq!(body["capabilities"]["devices"]["create"]["reusable"], false);
            }
            match result {
                Ok(key) => {
                    assert!(error.is_empty());
                    assert_eq!(key, fixture_key());
                }
                Err(e) => {
                    let e = format!("{e:#}");
                    assert!(!error.is_empty() && e.contains(error), "{e}");
                    assert!(!e.contains("fixture"), "{e}");
                }
            }
        }
    }
}
