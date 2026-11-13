mod config;
mod hosting;
mod metrics;
mod updater;

use anyhow::{Context, Result, bail, ensure};
use config::Config;
use reqwest::{StatusCode, blocking::Client, redirect::Policy};
use serde::Deserialize;
use std::{
    io::{self, Read},
    path::PathBuf,
    thread,
    time::Duration,
};

fn client() -> Result<Client> {
    Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .min_tls_version(reqwest::tls::Version::TLS_1_2)
        .user_agent(concat!("tenetd/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("Could not initialize HTTPS")
}
fn main() {
    if let Err(error) = execute() {
        // Network errors are deliberately reduced to static messages at the call sites.
        eprintln!("tenetd: {error:#}");
        std::process::exit(1);
    }
}
fn execute() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("help");
    if matches!(command, "help" | "--help" | "-h") {
        println!(
            "tenetd {}\n\n  enroll --panel https://panel.example.com --config /var/lib/tenetd/identity.json\n    Reads the one-use enrollment token from stdin.\n  run --config /var/lib/tenetd/identity.json [--once]\n  sample\n\nLinux systemd installation is available from Machines in your dashboard.",
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }
    if command == "configure-updater" {
        ensure!(
            args.len() == 4,
            "configure-updater requires a public key, panel origin and installed version"
        );
        return updater::configure(&args[1], &args[2], &args[3]);
    }
    if command == "update-worker" {
        ensure!(args.len() == 1, "update-worker takes no arguments");
        return updater::run();
    }
    if command == "--version" {
        println!("tenetd {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if command == "sample" {
        ensure!(args.len() == 1, "sample takes no arguments");
        let mut collector = metrics::Collector::new();
        thread::sleep(Duration::from_secs(1));
        println!("{}", serde_json::to_string(&collector.sample())?);
        return Ok(());
    }
    ensure!(
        matches!(command, "enroll" | "run"),
        "Unknown command; use --help"
    );
    let mut path = PathBuf::from("/var/lib/tenetd/identity.json");
    let mut panel = None;
    let mut once = false;
    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--config" => path = PathBuf::from(iter.next().context("Missing --config value")?),
            "--panel" if command == "enroll" => {
                panel = Some(iter.next().context("Missing --panel value")?.as_str())
            }
            "--once" if command == "run" => once = true,
            _ => bail!("Unknown option; use --help"),
        }
    }
    let client = client()?;
    if command == "enroll" {
        let panel = panel.context("--panel is required")?;
        let mut token = String::new();
        io::stdin().take(128).read_to_string(&mut token)?;
        let token = token.trim();
        ensure!(
            config::token(token),
            "Expected a 64-character enrollment token on stdin"
        );
        let mut identity = if path.try_exists()? {
            let saved = Config::load(&path)?;
            ensure!(
                saved.panel == config::panel_url(panel)?.origin().ascii_serialization(),
                "Identity belongs to a different panel"
            );
            ensure!(
                saved.machine_id.is_none(),
                "Already enrolled; revoke before reinstalling"
            );
            saved
        } else {
            let new = Config::new(panel)?;
            // Persist before transmission so retrying never generates a different credential.
            new.save(&path, true)?;
            new
        };
        #[derive(Deserialize)]
        struct Enrollment {
            id: String,
        }
        for attempt in 0..5 {
            let response = client
                .post(format!("{}/api/agent/enroll", identity.panel))
                .bearer_auth(token)
                .json(&serde_json::json!({"credential": identity.credential}))
                .send();
            match response {
                Ok(response) if response.status().is_success() => {
                    let mut bytes = Vec::new();
                    response.take(4097).read_to_end(&mut bytes).context(
                        "Incomplete enrollment response; retry with the same token and config",
                    )?;
                    ensure!(bytes.len() <= 4096, "Enrollment response too large");
                    let enrolled: Enrollment =
                        serde_json::from_slice(&bytes).context("Invalid enrollment response")?;
                    ensure!(
                        !enrolled.id.is_empty() && enrolled.id.len() <= 64,
                        "Invalid machine ID"
                    );
                    identity.machine_id = Some(enrolled.id);
                    identity.save(&path, false)?;
                    println!("Machine enrolled. Start tenetd run to send metrics.");
                    return Ok(());
                }
                Ok(response)
                    if !response.status().is_server_error()
                        && response.status() != StatusCode::TOO_MANY_REQUESTS =>
                {
                    bail!(
                        "Enrollment rejected (HTTP {}). Generate a fresh command if the token expired or was used.",
                        response.status().as_u16()
                    )
                }
                _ => {
                    if attempt < 4 {
                        thread::sleep(Duration::from_secs(2_u64.pow(attempt + 1)));
                    }
                }
            }
        }
        bail!(
            "Panel unavailable. Retry with the same token and identity file before the token expires."
        );
    }
    let identity = Config::load(&path)?;
    ensure!(
        identity.machine_id.is_some(),
        "Enrollment has not completed"
    );
    let mut collector = metrics::Collector::new();
    thread::sleep(Duration::from_secs(1));
    let mut failures = 0u32;
    loop {
        let response = client
            .post(format!("{}/api/agent/telemetry", identity.panel))
            .bearer_auth(&identity.credential)
            .json(&collector.sample())
            .send();
        match response {
            Ok(response) if response.status().is_success() => {
                failures = 0;
                if once {
                    println!("Metrics accepted.");
                    return Ok(());
                }
            }
            Ok(response)
                if matches!(
                    response.status(),
                    StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
                ) =>
            {
                eprintln!(
                    "Machine credential rejected or revoked. Stopping; re-enrollment is required."
                );
                std::process::exit(77);
            }
            Ok(response) => {
                eprintln!(
                    "Metrics rejected (HTTP {}). Retrying.",
                    response.status().as_u16()
                );
                failures = failures.saturating_add(1);
            }
            Err(_) => {
                eprintln!("Panel unavailable. Retrying.");
                failures = failures.saturating_add(1);
            }
        }
        if once {
            bail!("Metrics could not be delivered");
        }
        let delay = if failures == 0 {
            15
        } else {
            (15 * 2u64.pow(failures.min(4))).min(300)
        };
        let jitter = u64::from(rand::random::<u8>() % 4);
        thread::sleep(Duration::from_secs(delay + jitter));
    }
}
