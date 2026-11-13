use anyhow::{Context, Result, bail, ensure};
use rand::RngCore;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
};

// Deliberately no Debug: this object contains the machine's credential.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub panel: String,
    pub credential: String,
    pub machine_id: Option<String>,
}
pub fn panel_url(value: &str) -> Result<Url> {
    let url = Url::parse(value).context("Invalid panel URL")?;
    ensure!(
        url.scheme() == "https" || (url.scheme() == "http" && url.host_str() == Some("localhost")),
        "HTTPS is required; only localhost allows HTTP for development"
    );
    ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/",
        "Use a panel origin without a path, query, fragment or credentials"
    );
    Ok(url)
}
pub fn token(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl Config {
    pub fn new(panel: &str) -> Result<Self> {
        let panel = panel_url(panel)?.origin().ascii_serialization();
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let credential = bytes.iter().map(|b| format!("{b:02x}")).collect();
        Ok(Self {
            panel,
            credential,
            machine_id: None,
        })
    }
    pub fn load(path: &Path) -> Result<Self> {
        let metadata = fs::symlink_metadata(path).context("Cannot read identity file")?;
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "Identity must be a regular file"
        );
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "Identity permissions must be 0600"
        );
        ensure!(metadata.len() <= 4096, "Identity file is too large");
        let config: Self =
            serde_json::from_slice(&fs::read(path)?).context("Invalid identity file")?;
        panel_url(&config.panel)?;
        ensure!(token(&config.credential), "Invalid machine credential");
        Ok(config)
    }
    pub fn save(&self, path: &Path, first: bool) -> Result<()> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let metadata = fs::symlink_metadata(parent)
            .context("Create the identity directory first (mode 0700)")?;
        ensure!(
            metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && metadata.permissions().mode() & 0o077 == 0,
            "Identity directory must be private (0700), without a symlink"
        );
        let data = serde_json::to_vec(self)?;
        if first {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)?;
            file.write_all(&data)?;
            file.sync_all()?;
        } else {
            let tmp = path.with_extension("tmp");
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)
                .context("Cannot create identity update; inspect any leftover .tmp file")?;
            if let Err(error) = (|| -> Result<()> {
                file.write_all(&data)?;
                file.sync_all()?;
                fs::rename(&tmp, path)?;
                Ok(())
            })() {
                let _ = fs::remove_file(&tmp);
                bail!("Could not persist enrollment: {error}");
            }
        }
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_origins() {
        for value in [
            "http://example.com",
            "https://user:pass@example.com",
            "https://example.com/x",
            "https://example.com?x=y",
            "https://example.com#x",
        ] {
            assert!(panel_url(value).is_err());
        }
        assert!(panel_url("https://panel.example.com").is_ok());
        assert!(panel_url("http://localhost:3000").is_ok());
    }
    #[test]
    fn credential_format() {
        assert!(token(
            &Config::new("https://panel.example.com").unwrap().credential
        ));
        assert!(!token(&"g".repeat(64)));
        assert!(!token("short"));
    }
    #[test]
    fn private_persistence_and_no_overwrite() {
        let dir = std::env::temp_dir().join(format!("tenet-test-{}", rand::random::<u64>()));
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.join("identity.json");
        let mut config = Config::new("https://example.com").unwrap();
        config.save(&path, true).unwrap();
        assert!(config.save(&path, true).is_err());
        config.machine_id = Some("machine-id".into());
        config.save(&path, false).unwrap();
        assert_eq!(Config::load(&path).unwrap().machine_id, config.machine_id);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(Config::load(&path).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
