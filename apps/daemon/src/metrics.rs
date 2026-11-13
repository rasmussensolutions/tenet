use serde::Serialize;
use std::net::IpAddr;
use sysinfo::{Disks, Networks, System};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    version: u8,
    hostname: String,
    ip_addresses: Vec<String>,
    os: String,
    arch: &'static str,
    agent_build_id: &'static str,
    agent_version: &'static str,
    cpu_count: usize,
    cpu_percent: f32,
    memory_total: u64,
    memory_used: u64,
    uptime: u64,
    disks: Vec<Disk>,
}
#[derive(Serialize)]
struct Disk {
    mount: String,
    total: u64,
    used: u64,
}
pub struct Collector {
    system: System,
    disks: Disks,
}
fn label(value: String, max: usize) -> String {
    let clean: String = value
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect();
    if clean.is_empty() {
        "Unknown".into()
    } else {
        clean
    }
}
fn addresses() -> Vec<String> {
    let networks = Networks::new_with_refreshed_list();
    let mut addresses: Vec<IpAddr> = networks
        .iter()
        .flat_map(|(_, network)| network.ip_networks().iter().map(|network| network.addr))
        .filter(|address| {
            !address.is_loopback() && !address.is_unspecified() && !address.is_multicast()
        })
        .collect();
    addresses.sort();
    addresses.dedup();
    addresses.truncate(64);
    addresses
        .into_iter()
        .map(|address| address.to_string())
        .collect()
}
impl Collector {
    pub fn new() -> Self {
        let mut system = System::new();
        system.refresh_cpu_usage();
        Self {
            system,
            disks: Disks::new_with_refreshed_list(),
        }
    }
    pub fn sample(&mut self) -> Metrics {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.disks.refresh(true);
        let mut disks: Vec<Disk> = self
            .disks
            .iter()
            .filter(|disk| disk.total_space() > 0)
            .map(|disk| Disk {
                mount: label(disk.mount_point().to_string_lossy().into_owned(), 256),
                total: disk.total_space(),
                used: disk.total_space().saturating_sub(disk.available_space()),
            })
            .collect();
        disks.sort_by(|a, b| a.mount.cmp(&b.mount));
        disks.dedup_by(|a, b| a.mount == b.mount);
        disks.truncate(32);
        Metrics {
            version: 1,
            ip_addresses: addresses(),
            hostname: label(System::host_name().unwrap_or_else(|| "Unknown".into()), 120),
            os: label(
                System::long_os_version().unwrap_or_else(|| "Linux".into()),
                120,
            ),
            arch: std::env::consts::ARCH,
            agent_build_id: option_env!("TENET_BUILD_ID").unwrap_or("development"),
            agent_version: env!("CARGO_PKG_VERSION"),
            cpu_count: self.system.cpus().len(),
            cpu_percent: self.system.global_cpu_usage().clamp(0.0, 100.0),
            memory_total: self.system.total_memory(),
            memory_used: self.system.used_memory().min(self.system.total_memory()),
            uptime: System::uptime(),
            disks,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metrics_are_bounded_and_serializable() {
        let mut collector = Collector::new();
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        let sample = collector.sample();
        assert!(sample.cpu_count > 0);
        assert!(sample.cpu_percent >= 0.0 && sample.cpu_percent <= 100.0);
        assert!(sample.memory_total > 0 && sample.memory_used <= sample.memory_total);
        assert!(sample.disks.len() <= 32);
        assert!(sample.disks.iter().all(|d| d.used <= d.total));
        assert!(serde_json::to_vec(&sample).unwrap().len() < 32768);
    }
}
