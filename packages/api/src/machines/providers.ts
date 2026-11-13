/** Display metadata only; never use provider labels for authorization. */
export const DETECTED_PROVIDERS = [
  "Hetzner",
  "AWS",
  "Google Cloud",
  "Azure",
  "DigitalOcean",
  "Linode",
] as const;
export type DetectedProvider = (typeof DETECTED_PROVIDERS)[number];
export interface Hosting {
  provider: DetectedProvider;
  region?: string;
  zone?: string;
}
export const PROVIDER_SUGGESTIONS = [
  ...DETECTED_PROVIDERS,
  "netcup",
  "OVHcloud",
  "Vultr",
  "Scaleway",
  "UpCloud",
  "Contabo",
  "IONOS",
  "Hostinger",
  "Oracle Cloud",
  "Self-hosted",
] as const;
