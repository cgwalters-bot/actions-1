use anyhow::{Context, Result, bail, ensure};
use reqwest::{Url, blocking::Client, redirect::Policy};
use serde_json::{Map, Value};
use std::{collections::BTreeMap, env, fs, io::Write, path::Path, time::Duration};

const TIMEOUT: Duration = Duration::from_secs(30);
const EXCHANGE: &str = "https://api.tailscale.com/api/v2/oauth/token-exchange";
const KEYS: [&str; 4] = ["oauth-client-id", "audience", "tags", "proxy"];

fn settings(
    owners: &Map<String, Value>,
    owner: &str,
    overrides: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>> {
    let nonempty = |key: &str| overrides.get(key).filter(|v| !v.is_empty());
    ensure!(
        owners.contains_key(owner)
            || (nonempty("oauth-client-id").is_some() && nonempty("tags").is_some()),
        "No tailnet settings for GitHub organization {owner}; add an entry to tailscale/tailnets.json, or give both oauth-client-id and tags."
    );
    let mut result = BTreeMap::new();
    for key in ["oauth-client-id", "tags", "proxy"] {
        let value = nonempty(key).cloned().unwrap_or_else(|| {
            owners
                .get(owner)
                .and_then(|v| v.get(key))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        });
        result.insert(key.to_owned(), value);
    }
    result.insert(
        "audience".into(),
        nonempty("audience")
            .cloned()
            .unwrap_or_else(|| format!("api.tailscale.com/{}", result["oauth-client-id"])),
    );
    // A newline here could inject another GitHub step output.
    ensure!(
        result.values().all(|v| !v.contains(['\r', '\n'])),
        "Tailnet settings must be single-line values"
    );
    Ok(result)
}

pub fn setup(path: &Path) -> Result<()> {
    let owners = serde_json::from_slice(&fs::read(path).context("read tailnet settings")?)
        .context("parse tailnet settings")?;
    let overrides = KEYS
        .into_iter()
        .map(|key| {
            (
                key.to_owned(),
                env::var(key.to_uppercase().replace('-', "_")).unwrap_or_default(),
            )
        })
        .collect();
    let values = settings(&owners, &super::required("REPOSITORY_OWNER")?, &overrides)?;
    // Validate everything before opening the output file.
    let mut output = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(super::required("GITHUB_OUTPUT")?)
        .context("open GitHub output")?;
    for key in ["oauth-client-id", "tags", "proxy", "audience"] {
        writeln!(output, "{key}={}", values[key]).context("append GitHub output")?;
    }
    Ok(())
}

struct Response {
    status: u16,
    json: Value,
}

enum Request<'a> {
    Oidc { url: Url, token: &'a str },
    Exchange { client: &'a str, jwt: &'a str },
    Probe(Url),
}

fn identity(response: Response) -> Result<Value> {
    ensure!(
        (200..300).contains(&response.status),
        "Identity request failed: HTTP {}",
        response.status
    );
    Ok(response.json)
}

fn check_with(
    oidc_url: &str,
    token: &str,
    audience: &str,
    client: &str,
    proxy: &str,
    mut request: impl FnMut(Request<'_>) -> Result<Response>,
    output: &mut impl Write,
) -> Result<()> {
    // Do not include endpoint URLs, token values or response bodies in errors.
    let mut url = Url::parse(oidc_url).map_err(|_| anyhow::anyhow!("invalid OIDC request URL"))?;
    let pairs: Vec<_> = url
        .query_pairs()
        .filter(|(k, _)| k != "audience")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.set_query(None);
    url.query_pairs_mut()
        .extend_pairs(pairs)
        .append_pair("audience", audience);
    let oidc = identity(request(Request::Oidc { url, token })?)?;
    let jwt = oidc
        .get("value")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .context("OIDC response did not include a token")?;
    let exchange = identity(request(Request::Exchange { client, jwt })?)?;
    let scope = exchange
        .get("scope")
        .and_then(Value::as_str)
        .context("Token response did not include granted scopes")?;
    writeln!(output, "Granted scopes: {scope}")?;
    let url = Url::parse(proxy)
        .and_then(|url| url.join("/v1/runs"))
        .map_err(|_| anyhow::anyhow!("invalid proxy URL"))?;
    let response = request(Request::Probe(url))?;
    ensure!(
        response.status == 401,
        "Proxy returned HTTP {}; expected 401",
        response.status
    );
    writeln!(
        output,
        "Proxy returned the expected unauthenticated HTTP 401"
    )?;
    Ok(())
}

pub fn check() -> Result<()> {
    let client = Client::builder()
        .timeout(TIMEOUT)
        .redirect(Policy::none())
        .build()
        .context("build HTTP client")?;
    check_with(
        &super::required("ACTIONS_ID_TOKEN_REQUEST_URL")?,
        &super::required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")?,
        &super::required("AUDIENCE")?,
        &super::required("OAUTH_CLIENT_ID")?,
        &super::required("PROXY")?,
        |request| {
            let (request, probe) = match request {
                Request::Oidc { url, token } => (client.get(url).bearer_auth(token), false),
                Request::Exchange { client: id, jwt } => (
                    client
                        .post(EXCHANGE)
                        .form(&[("client_id", id), ("jwt", jwt)]),
                    false,
                ),
                Request::Probe(url) => (client.post(url), true),
            };
            let response = request
                .send()
                .map_err(|_| anyhow::anyhow!("identity/proxy request failed"))?;
            let status = response.status().as_u16();
            let json = if probe || !(200..300).contains(&status) {
                Value::Null
            } else {
                // Bound JSON reads too: a malformed endpoint must not consume unlimited memory.
                use std::io::Read;
                let mut bytes = Vec::new();
                response
                    .take(1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .context("read identity response")?;
                if bytes.len() > 1024 * 1024 {
                    bail!("identity response exceeds 1 MiB");
                }
                serde_json::from_slice(&bytes).context("decode identity response")?
            };
            Ok(Response { status, json })
        },
        &mut std::io::stdout().lock(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn settings_defaults_overrides_and_rejections() {
        let owners = json!({"known": {"oauth-client-id": "client", "tags": "tag:test", "proxy": "http://192.0.2.1"}});
        let owners = owners.as_object().unwrap();
        let base = settings(owners, "known", &BTreeMap::new()).unwrap();
        assert_eq!(base["audience"], "api.tailscale.com/client");
        assert_eq!(base["proxy"], "http://192.0.2.1");
        for owner in ["unknown", "__proto__", "constructor"] {
            for entries in [
                vec![],
                vec![("oauth-client-id", "other")],
                vec![("tags", "tag:other")],
            ] {
                let overrides = entries
                    .into_iter()
                    .map(|(k, v)| (k.into(), v.into()))
                    .collect();
                assert!(settings(owners, owner, &overrides).is_err());
            }
            let overrides = BTreeMap::from([
                ("oauth-client-id".into(), "other".into()),
                ("tags".into(), "tag:other".into()),
            ]);
            let result = settings(owners, owner, &overrides).unwrap();
            assert_eq!(result["audience"], "api.tailscale.com/other");
            assert_eq!(result["proxy"], "");
        }
        for key in KEYS {
            for newline in ["\n", "\r", "\r\n"] {
                assert!(
                    settings(
                        owners,
                        "known",
                        &BTreeMap::from([(key.into(), format!("a{newline}injected=value"))])
                    )
                    .is_err()
                );
            }
            assert_eq!(
                settings(
                    owners,
                    "known",
                    &BTreeMap::from([(key.into(), String::new())])
                )
                .unwrap(),
                base
            );
            assert_eq!(
                settings(
                    owners,
                    "known",
                    &BTreeMap::from([(key.into(), "custom".into())])
                )
                .unwrap()[key],
                "custom"
            );
        }
    }

    #[test]
    fn check_requests_and_failures() {
        for (statuses, bodies, error) in [
            (
                [200, 200, 401],
                [
                    json!({"value":"oidc-value"}),
                    json!({"scope":"auth_keys", "access_token":"not-printed"}),
                ],
                "",
            ),
            ([403, 200, 401], [json!({}), json!({})], "HTTP 403"),
            ([200, 200, 401], [json!({}), json!({})], "include a token"),
            (
                [200, 401, 401],
                [json!({"value":"oidc-value"}), json!({})],
                "HTTP 401",
            ),
            (
                [200, 200, 401],
                [json!({"value":"oidc-value"}), json!({})],
                "granted scopes",
            ),
            (
                [200, 200, 200],
                [json!({"value":"oidc-value"}), json!({"scope":"auth_keys"})],
                "expected 401",
            ),
            (
                [200, 200, 302],
                [json!({"value":"oidc-value"}), json!({"scope":"auth_keys"})],
                "expected 401",
            ),
        ] {
            let mut calls = 0;
            let mut output = Vec::new();
            let result = check_with(
                "https://192.0.2.1/token?existing=1&audience=old",
                "request-value",
                "aud",
                "client",
                "http://192.0.2.1/ignored",
                |request| {
                    match request {
                        Request::Oidc { url, token } => {
                            assert_eq!(token, "request-value");
                            assert_eq!(
                                url.query_pairs()
                                    .filter(|(k, _)| k == "audience")
                                    .collect::<Vec<_>>(),
                                [("audience".into(), "aud".into())]
                            );
                            assert!(url.query_pairs().any(|(k, v)| k == "existing" && v == "1"));
                        }
                        Request::Exchange { client, jwt } => {
                            assert_eq!(client, "client");
                            assert_eq!(jwt, "oidc-value");
                        }
                        Request::Probe(url) => assert_eq!(url.as_str(), "http://192.0.2.1/v1/runs"),
                    }
                    let response = Response {
                        status: statuses[calls],
                        json: bodies.get(calls).cloned().unwrap_or(Value::Null),
                    };
                    calls += 1;
                    Ok(response)
                },
                &mut output,
            );
            if error.is_empty() {
                result.unwrap();
                assert_eq!(calls, 3);
                assert_eq!(
                    String::from_utf8(output).unwrap(),
                    "Granted scopes: auth_keys\nProxy returned the expected unauthenticated HTTP 401\n"
                );
            } else {
                assert!(result.unwrap_err().to_string().contains(error));
            }
        }
    }
}
