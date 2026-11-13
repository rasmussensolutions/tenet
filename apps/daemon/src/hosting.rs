//! Best-effort display metadata. Never used for trust, enrollment or update policy.
use reqwest::{Method, blocking::Client, redirect::Policy};
use serde::Serialize;
use std::{
    io::Read,
    sync::mpsc::{self, Receiver, Sender},
    time::Duration,
};

const METADATA_ORIGIN: &str = "http://169.254.169.254";
const RESPONSE_LIMIT: u64 = 16 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_millis(600);
const RETRY_INTERVAL: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Hosting {
    pub provider: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
}

/// Discovery never blocks metric collection. Cache a successful result until restart;
/// retry unavailable metadata slowly. Dropping the collector stops the retry worker.
pub struct Discovery {
    results: Receiver<Hosting>,
    _stop: Sender<()>,
    current: Option<Hosting>,
}
impl Discovery {
    pub fn new() -> Self {
        let (send, results) = mpsc::channel();
        let (stop, stopped) = mpsc::channel();
        std::thread::spawn(move || {
            if !cfg!(target_os = "linux")
                || [
                    "/.dockerenv",
                    "/run/.containerenv",
                    "/run/systemd/container",
                ]
                .iter()
                .any(|path| std::path::Path::new(path).exists())
            {
                return;
            }
            let Ok(client) = metadata_client() else {
                return;
            };
            loop {
                // These paths/headers are compiled into the daemon. Neither the panel
                // nor a metadata response can supply a URL to fetch.
                if let Some(hosting) = detect(|method, path, headers| {
                    request(&client, METADATA_ORIGIN, method, path, headers)
                }) {
                    let _ = send.send(hosting);
                    return;
                }
                if !matches!(
                    stopped.recv_timeout(RETRY_INTERVAL),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ) {
                    return;
                }
            }
        });
        Self {
            results,
            _stop: stop,
            current: None,
        }
    }
    pub fn sample(&mut self) -> Option<Hosting> {
        if let Ok(hosting) = self.results.try_recv() {
            self.current = Some(hosting);
        }
        self.current.clone()
    }
}

fn metadata_client() -> reqwest::Result<Client> {
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(REQUEST_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
}
fn request(
    client: &Client,
    origin: &str,
    method: Method,
    path: &str,
    headers: &[(&str, &str)],
) -> Option<String> {
    let mut request = client.request(method, format!("{origin}{path}"));
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request.send().ok()?;
    if response.status() != reqwest::StatusCode::OK
        || response
            .content_length()
            .is_some_and(|length| length > RESPONSE_LIMIT)
    {
        return None;
    }
    let mut bytes = Vec::new();
    response
        .take(RESPONSE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > RESPONSE_LIMIT {
        return None;
    }
    String::from_utf8(bytes).ok()
}
fn component(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 100
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return None;
    }
    Some(value.to_owned())
}
fn token(value: String) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 1024 || !value.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return None;
    }
    Some(value.to_owned())
}
fn detect(
    mut fetch: impl FnMut(Method, &str, &[(&str, &str)]) -> Option<String>,
) -> Option<Hosting> {
    // Only explicit, non-secret metadata fields are fetched; never user-data or IAM credentials.
    if let Some(zone) = fetch(Method::GET, "/hetzner/v1/metadata/availability-zone", &[])
        .and_then(|s| component(&s))
    {
        let region =
            fetch(Method::GET, "/hetzner/v1/metadata/region", &[]).and_then(|s| component(&s));
        return Some(Hosting {
            provider: "Hetzner",
            region,
            zone: Some(zone),
        });
    }
    if let Some(token) = fetch(
        Method::PUT,
        "/latest/api/token",
        &[("X-aws-ec2-metadata-token-ttl-seconds", "60")],
    )
    .and_then(token)
    {
        let headers = [("X-aws-ec2-metadata-token", token.as_str())];
        if let Some(region) = fetch(Method::GET, "/latest/meta-data/placement/region", &headers)
            .and_then(|s| component(&s))
        {
            let zone = fetch(
                Method::GET,
                "/latest/meta-data/placement/availability-zone",
                &headers,
            )
            .and_then(|s| component(&s));
            return Some(Hosting {
                provider: "AWS",
                region: Some(region),
                zone,
            });
        }
    }
    if let Some(path) = fetch(
        Method::GET,
        "/computeMetadata/v1/instance/zone",
        &[("Metadata-Flavor", "Google")],
    ) {
        if let Some(zone) = path.trim().rsplit('/').next().and_then(component) {
            if let Some((region, suffix)) = zone.rsplit_once('-') {
                if region.ends_with(|c: char| c.is_ascii_digit())
                    && suffix.len() == 1
                    && suffix.bytes().all(|c| c.is_ascii_lowercase())
                {
                    return Some(Hosting {
                        provider: "Google Cloud",
                        region: component(region),
                        zone: Some(zone),
                    });
                }
            }
        }
    }
    const AZURE_LOCATION: &str =
        "/metadata/instance/compute/location?api-version=2021-02-01&format=text";
    if let Some(region) =
        fetch(Method::GET, AZURE_LOCATION, &[("Metadata", "true")]).and_then(|s| component(&s))
    {
        let zone = fetch(
            Method::GET,
            "/metadata/instance/compute/zone?api-version=2021-02-01&format=text",
            &[("Metadata", "true")],
        )
        .and_then(|s| component(&s));
        return Some(Hosting {
            provider: "Azure",
            region: Some(region),
            zone,
        });
    }
    if let Some(region) = fetch(Method::GET, "/metadata/v1/region", &[]).and_then(|s| component(&s))
    {
        return Some(Hosting {
            provider: "DigitalOcean",
            region: Some(region),
            zone: None,
        });
    }
    if let Some(token) = fetch(
        Method::PUT,
        "/v1/token",
        &[("Metadata-Token-Expiry-Seconds", "60")],
    )
    .and_then(token)
    {
        if let Some(body) = fetch(
            Method::GET,
            "/v1/instance",
            &[("Metadata-Token", &token), ("Accept", "application/json")],
        ) {
            let value: serde_json::Value = serde_json::from_str(&body).ok()?;
            let region = component(value.get("region")?.as_str()?)?;
            return Some(Hosting {
                provider: "Linode",
                region: Some(region),
                zone: None,
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener};

    #[test]
    fn detects_each_provider_and_only_returns_allowed_fields() {
        let cases = [
            (
                "Hetzner",
                vec![
                    ("/hetzner/v1/metadata/availability-zone", "hel1-dc2"),
                    ("/hetzner/v1/metadata/region", "eu-central"),
                ],
                "eu-central",
                Some("hel1-dc2"),
            ),
            (
                "AWS",
                vec![
                    ("/latest/api/token", "test-token"),
                    ("/latest/meta-data/placement/region", "eu-west-1"),
                    (
                        "/latest/meta-data/placement/availability-zone",
                        "eu-west-1a",
                    ),
                ],
                "eu-west-1",
                Some("eu-west-1a"),
            ),
            (
                "Google Cloud",
                vec![(
                    "/computeMetadata/v1/instance/zone",
                    "projects/123/zones/europe-west2-a",
                )],
                "europe-west2",
                Some("europe-west2-a"),
            ),
            (
                "Azure",
                vec![
                    (
                        "/metadata/instance/compute/location?api-version=2021-02-01&format=text",
                        "westeurope",
                    ),
                    (
                        "/metadata/instance/compute/zone?api-version=2021-02-01&format=text",
                        "1",
                    ),
                ],
                "westeurope",
                Some("1"),
            ),
            (
                "DigitalOcean",
                vec![("/metadata/v1/region", "ams3")],
                "ams3",
                None,
            ),
            (
                "Linode",
                vec![
                    ("/v1/token", "test-token"),
                    (
                        "/v1/instance",
                        r#"{"region":"eu-west","id":123,"label":"private"}"#,
                    ),
                ],
                "eu-west",
                None,
            ),
        ];
        for (provider, responses, region, zone) in cases {
            let result = detect(|method, path, headers| {
                if path == "/latest/api/token" || path == "/v1/token" {
                    assert_eq!(method, Method::PUT);
                }
                if path.starts_with("/latest/meta-data/") {
                    assert!(headers.contains(&("X-aws-ec2-metadata-token", "test-token")));
                }
                if path.starts_with("/computeMetadata/") {
                    assert!(headers.contains(&("Metadata-Flavor", "Google")));
                }
                if path.starts_with("/metadata/instance/") {
                    assert!(headers.contains(&("Metadata", "true")));
                }
                if path == "/v1/instance" {
                    assert!(headers.contains(&("Metadata-Token", "test-token")));
                    assert!(headers.contains(&("Accept", "application/json")));
                }
                responses
                    .iter()
                    .find(|(key, _)| *key == path)
                    .map(|(_, value)| (*value).to_owned())
            })
            .unwrap();
            assert_eq!(result.provider, provider);
            assert_eq!(result.region.as_deref(), Some(region));
            assert_eq!(result.zone.as_deref(), zone);
            assert!(!serde_json::to_string(&result).unwrap().contains("private"));
        }
    }
    #[test]
    fn unavailable_or_malformed_metadata_remains_unknown() {
        assert!(detect(|_, _, _| None).is_none());
        for value in ["", "<html>not metadata</html>", "region\r\nInjected: yes"] {
            assert!(detect(|_, _, _| Some(value.into())).is_none());
        }
        assert!(component(&"a".repeat(101)).is_none());
        assert!(token("abc\r\nHeader: value".into()).is_none());
        assert!(token("a".repeat(1025)).is_none());
    }
    fn mock_response(response: String) -> Option<String> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = [0; 4096];
            let _ = stream.read(&mut bytes);
            let _ = stream.write_all(response.as_bytes());
        });
        let result = request(
            &metadata_client().unwrap(),
            &format!("http://{address}"),
            Method::GET,
            "/test",
            &[],
        );
        worker.join().unwrap();
        result
    }
    #[test]
    fn transport_rejects_redirects_errors_and_oversized_bodies() {
        let redirect_target = TcpListener::bind("127.0.0.1:0").unwrap();
        redirect_target.set_nonblocking(true).unwrap();
        assert_eq!(
            mock_response("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nhel1".into()).as_deref(),
            Some("hel1")
        );
        assert!(
            mock_response(format!(
                "HTTP/1.1 302 Found\r\nLocation: http://{}/secret\r\nContent-Length: 0\r\n\r\n",
                redirect_target.local_addr().unwrap()
            ))
            .is_none()
        );
        assert_eq!(
            redirect_target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        assert!(
            mock_response("HTTP/1.1 404 Not Found\r\nContent-Length: 4\r\n\r\nhel1".into())
                .is_none()
        );
        assert!(
            mock_response(format!(
                "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}",
                "a".repeat(RESPONSE_LIMIT as usize + 1)
            ))
            .is_none()
        );
    }
}
