//! Root-only, fixed-purpose updater. No shell commands or caller-selected filesystem paths.
use anyhow::{Context, Result, bail, ensure};
use ed25519_dalek::{Signature, VerifyingKey};
use fs2::FileExt;
use reqwest::{blocking::Client, redirect::Policy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
    process::Command,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const CONFIG: &str = "/etc/tenet/updater.json";
const STATE: &str = "/var/lib/tenet-updater";
const BINARY: &str = "/usr/local/bin/tenetd";
const STAGED: &str = "/usr/local/bin/.tenetd-update";
const MAX_BINARY: u64 = 32 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    panel: String,
    credential: String,
    public_key: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    manifest: String,
    signature: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema: u8,
    version: String,
    build_id: String,
    protocol: u8,
    updater_protocol: u8,
    channel: String,
    expires_at: u64,
    artifacts: BTreeMap<String, Artifact>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    url: String,
    sha256: String,
    size: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: String,
    envelope: Envelope,
    expires_at: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    job: Job,
    previous_hash: String,
    previous_version: String,
    status: String,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn decode<const N: usize>(value: &str) -> Result<[u8; N]> {
    ensure!(
        value.len() == N * 2
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Invalid hexadecimal value"
    );
    let mut out = [0; N];
    for (i, item) in out.iter_mut().enumerate() {
        *item = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16)?;
    }
    Ok(out)
}
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn version(value: &str) -> Result<[u32; 3]> {
    let parts: Vec<&str> = value.split('.').collect();
    ensure!(parts.len() == 3, "Invalid version");
    let mut out = [0; 3];
    for (i, part) in parts.iter().enumerate() {
        ensure!(
            !part.is_empty()
                && part.len() <= 6
                && part.bytes().all(|b| b.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0')),
            "Invalid version"
        );
        out[i] = part.parse()?;
    }
    Ok(out)
}
fn verify(envelope: &Envelope, key: &str, installed: &str) -> Result<Manifest> {
    ensure!(envelope.manifest.len() <= 12000, "Manifest too large");
    VerifyingKey::from_bytes(&decode::<32>(key)?)?
        .verify_strict(
            envelope.manifest.as_bytes(),
            &Signature::from_bytes(&decode::<64>(&envelope.signature)?),
        )
        .context("Release signature rejected")?;
    let manifest: Manifest = serde_json::from_str(&envelope.manifest)?;
    ensure!(
        manifest.schema == 1
            && manifest.protocol == 1
            && manifest.updater_protocol == 1
            && manifest.channel == "stable"
            && manifest.expires_at > now(),
        "Expired or incompatible release"
    );
    ensure!(
        version(&manifest.version)? > version(installed)?,
        "Downgrade or same-version update rejected"
    );
    ensure!(
        (40..=64).contains(&manifest.build_id.len())
            && manifest.build_id.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid build identity"
    );
    for (arch, artifact) in &manifest.artifacts {
        ensure!(
            ["x86_64", "aarch64"].contains(&arch.as_str()),
            "Unsupported architecture"
        );
        decode::<32>(&artifact.sha256)?;
        ensure!(
            artifact.size > 0 && artifact.size <= MAX_BINARY,
            "Invalid artifact size"
        );
        let url = reqwest::Url::parse(&artifact.url)?;
        ensure!(
            url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none(),
            "Invalid artifact URL"
        );
    }
    Ok(manifest)
}
fn private_file(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.is_file() && meta.uid() == 0 && meta.permissions().mode() & 0o077 == 0,
        "Expected a root-owned private regular file"
    );
    Ok(())
}
fn directory(path: &Path) -> Result<()> {
    if !path.exists() {
        fs::create_dir(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.is_dir() && meta.uid() == 0 && meta.permissions().mode() & 0o022 == 0,
        "Unsafe updater directory"
    );
    Ok(())
}
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension("new");
    // Only root can write the containing directory. Reject unexpected existing temp files.
    if temp.exists() {
        private_file(&temp)?;
        fs::remove_file(&temp)?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temp, path)?;
    File::open(path.parent().context("Missing parent")?)?.sync_all()?;
    Ok(())
}
fn systemctl(action: &str) -> Result<()> {
    let mut command = Command::new("/usr/bin/systemctl");
    command
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .args([action, "tenetd.service"]);
    let mut child = command.spawn()?;
    for _ in 0..100 {
        if let Some(status) = child.try_wait()? {
            ensure!(status.success(), "systemctl failed");
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }
    let _ = child.kill();
    let _ = child.wait();
    bail!("systemctl timed out")
}
fn install(bytes: &[u8]) -> Result<()> {
    directory(Path::new("/usr/local/bin"))?;
    if Path::new(STAGED).exists() {
        let meta = fs::symlink_metadata(STAGED)?;
        ensure!(meta.is_file() && meta.uid() == 0, "Unsafe staging file");
        fs::remove_file(STAGED)?;
    }
    let mut staged = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o755)
        .open(STAGED)?;
    staged.write_all(bytes)?;
    // UMask=0077 protects state, but the monitoring user must execute this file.
    staged.set_permissions(fs::Permissions::from_mode(0o755))?;
    staged.sync_all()?;
    fs::rename(STAGED, BINARY)?;
    File::open("/usr/local/bin")?.sync_all()?;
    Ok(())
}
fn read_limited(path: &Path, max: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?.take(max + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= max, "File too large");
    Ok(bytes)
}
fn post(
    client: &Client,
    settings: &Settings,
    action: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value> {
    let response = client
        .post(format!("{}/api/agent/updates/{action}", settings.panel))
        .bearer_auth(&settings.credential)
        .json(&body)
        .send()
        .map_err(|_| anyhow::anyhow!("Panel unavailable"))?;
    ensure!(
        response.status().is_success(),
        "Panel rejected updater request"
    );
    let mut bytes = Vec::new();
    response.take(20001).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 20000, "Panel response too large");
    Ok(serde_json::from_slice(&bytes)?)
}
fn report(client: &Client, settings: &Settings, journal: &Journal) -> Result<()> {
    post(
        client,
        settings,
        "report",
        serde_json::json!({"id":journal.job.id,"status":journal.status,"error": if journal.status == "rolled_back" {Some("Update did not complete health verification; previous binary restored.")} else if journal.status == "failed" {Some("Release verification or download failed before installation.")} else {None}}),
    )?;
    Ok(())
}
fn restore(journal: &mut Journal, state: &Path) -> Result<()> {
    let backup = read_limited(&state.join("previous"), MAX_BINARY)?;
    ensure!(
        digest(&backup) == journal.previous_hash,
        "Backup integrity check failed; manual recovery required"
    );
    install(&backup)?;
    systemctl("restart")?;
    write_private(&state.join("version"), journal.previous_version.as_bytes())?;
    journal.status = "rolled_back".into();
    write_private(&state.join("journal.json"), &serde_json::to_vec(journal)?)?;
    Ok(())
}
pub fn configure(key: &str, panel: &str, installed: &str) -> Result<()> {
    root()?;
    decode::<32>(key)?;
    version(installed)?;
    directory(Path::new("/etc/tenet"))?;
    ensure!(
        !Path::new(CONFIG).exists(),
        "Updater is already configured; change trust only through local administration"
    );
    let identity = crate::config::Config::load(Path::new("/var/lib/tenetd/identity.json"))?;
    ensure!(
        identity.panel.starts_with("https://") && identity.panel == panel,
        "Updater panel must match the enrolled HTTPS identity"
    );
    write_private(
        Path::new(CONFIG),
        &serde_json::to_vec(&Settings {
            panel: identity.panel,
            credential: identity.credential,
            public_key: key.into(),
        })?,
    )?;
    directory(Path::new(STATE))?;
    write_private(&Path::new(STATE).join("version"), installed.as_bytes())?;
    Ok(())
}
fn root() -> Result<()> {
    ensure!(
        Command::new("/usr/bin/id").arg("-u").output()?.stdout == b"0\n",
        "Updater requires root"
    );
    Ok(())
}
pub fn run() -> Result<()> {
    root()?;
    private_file(Path::new(CONFIG))?;
    let settings: Settings = serde_json::from_slice(&read_limited(Path::new(CONFIG), 4096)?)?;
    crate::config::panel_url(&settings.panel)?;
    ensure!(
        settings.panel.starts_with("https://") && crate::config::token(&settings.credential),
        "Invalid updater identity"
    );
    decode::<32>(&settings.public_key)?;
    let state = Path::new(STATE);
    directory(state)?;
    if state.join("lock").exists() {
        private_file(&state.join("lock"))?;
    }
    let lock = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(state.join("lock"))?;
    if lock.try_lock_exclusive().is_err() {
        return Ok(());
    }
    let client = super::client()?;
    let journal_path = state.join("journal.json");
    if journal_path.exists() {
        private_file(&journal_path)?;
        let mut journal: Journal = serde_json::from_slice(&read_limited(&journal_path, 24000)?)?;
        if !["succeeded", "rolled_back", "failed"].contains(&journal.status.as_str()) {
            restore(&mut journal, state)?;
        }
        // Persist the receipt until acknowledged; never repeat a job after an ambiguous response.
        report(&client, &settings, &journal)?;
    }
    let response = post(
        &client,
        &settings,
        "next",
        serde_json::json!({"publicKey":settings.public_key}),
    )?;
    if response["job"].is_null() {
        return Ok(());
    }
    let job: Job = serde_json::from_value(response["job"].clone())?;
    if journal_path.exists() {
        let old: Journal = serde_json::from_slice(&read_limited(&journal_path, 24000)?)?;
        if old.job.id == job.id {
            return Ok(());
        }
    }
    ensure!(job.expires_at > now(), "Update request expired");
    private_file(&state.join("version"))?;
    let installed = String::from_utf8(read_limited(&state.join("version"), 64)?)?;
    let mut journal = Journal {
        job,
        previous_hash: String::new(),
        previous_version: installed.clone(),
        status: "failed".into(),
    };
    let result = (|| -> Result<()> {
        let manifest = verify(&journal.job.envelope, &settings.public_key, &installed)?;
        let artifact = manifest
            .artifacts
            .get(std::env::consts::ARCH)
            .context("No artifact for this architecture")?;
        journal.status = "downloading".into();
        report(&client, &settings, &journal)?;
        // Release URLs are authorized by the pinned signer. Redirects may only remain HTTPS;
        // credentials are never attached to artifact requests (GitHub uses signed CDN redirects).
        let download = Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(Policy::limited(5))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(180))
            .build()?;
        let response = download
            .get(&artifact.url)
            .send()
            .map_err(|_| anyhow::anyhow!("Artifact download failed"))?;
        ensure!(response.status().is_success(), "Artifact download rejected");
        let mut bytes = Vec::new();
        response.take(artifact.size + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 == artifact.size && digest(&bytes) == artifact.sha256,
            "Artifact integrity rejected"
        );
        let meta = fs::symlink_metadata(BINARY)?;
        ensure!(
            meta.is_file() && meta.uid() == 0 && meta.permissions().mode() & 0o022 == 0,
            "Unsafe installed binary"
        );
        let previous = read_limited(Path::new(BINARY), MAX_BINARY)?;
        journal.previous_hash = digest(&previous);
        write_private(&state.join("previous"), &previous)?;
        journal.status = "installing".into();
        write_private(&journal_path, &serde_json::to_vec(&journal)?)?;
        report(&client, &settings, &journal)?;
        ensure!(
            journal.job.expires_at > now() && manifest.expires_at > now(),
            "Update request or release expired before installation"
        );
        install(&bytes)?;
        let started = now();
        systemctl("restart")?;
        for _ in 0..18 {
            thread::sleep(Duration::from_secs(5));
            if let Ok(health) = post(&client, &settings, "health", serde_json::json!({})) {
                if health["lastSeen"].as_u64().unwrap_or(0) >= started
                    && health["telemetry"]["agentVersion"] == manifest.version
                    && health["telemetry"]["agentBuildId"] == manifest.build_id
                {
                    write_private(&state.join("version"), manifest.version.as_bytes())?;
                    journal.status = "succeeded".into();
                    write_private(&journal_path, &serde_json::to_vec(&journal)?)?;
                    return Ok(());
                }
            }
        }
        bail!("New agent did not report healthy")
    })();
    if result.is_err() {
        if journal.status == "installing" {
            restore(&mut journal, state)?;
        } else {
            journal.status = "failed".into();
            write_private(&journal_path, &serde_json::to_vec(&journal)?)?;
        }
    }
    report(&client, &settings, &journal)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    fn signed(key: &SigningKey, version: &str) -> Envelope {
        let manifest = serde_json::json!({"schema":1,"version":version,"buildId":"a".repeat(40),"protocol":1,"updaterProtocol":1,"channel":"stable","expiresAt":now()+60000,"artifacts":{"x86_64":{"url":"https://example.com/binary","sha256":"b".repeat(64),"size":10}}}).to_string();
        let signature = key
            .sign(manifest.as_bytes())
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        Envelope {
            manifest,
            signature,
        }
    }
    #[test]
    fn rejects_tampering_wrong_keys_and_downgrades() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let public = key
            .verifying_key()
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let envelope = signed(&key, "0.2.0");
        assert!(verify(&envelope, &public, "0.1.0").is_ok());
        assert!(verify(&envelope, &public, "0.2.0").is_err());
        assert!(verify(&envelope, &public, "1.0.0").is_err());
        let mut bad = envelope.clone();
        bad.manifest.push(' ');
        assert!(verify(&bad, &public, "0.1.0").is_err());
        assert!(verify(&envelope, &"a".repeat(64), "0.1.0").is_err());
    }
    #[test]
    fn versions_are_strict_and_numeric() {
        assert!(version("0.10.0").unwrap() > version("0.9.0").unwrap());
        for v in ["1.2", "01.2.3", "1.2.3-beta", "1.2.3;id"] {
            assert!(version(v).is_err());
        }
    }
}
