import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ plugins: [passkeyClient()] });
export interface SessionInfo {
  user: { id: string; name: string };
  session: { id: string; expiresAt: string; freshUntil: string };
  recoveryCodesRemaining: number;
}
const messages: Record<string, string> = {
  NO_VERIFIED_RELEASE:
    "No verified release is available. Check the panel's release configuration.",
  UPDATER_BOOTSTRAP_REQUIRED:
    "Enable the updater on this VPS and wait for it to connect before updating.",
  NO_COMPATIBLE_UPDATE:
    "There is no newer compatible daemon release for this machine.",
  UPDATE_ALREADY_RUNNING: "An update is already in progress on this machine.",
  INVALID_MACHINE_NAME: "Enter a machine name between 1 and 80 characters.",
  DAEMON_NOT_AVAILABLE:
    "Build and bundle the Linux daemon on your panel deployment first. See docs/machines.md.",
  HTTPS_REQUIRED:
    "Connecting a VPS requires a publicly reachable HTTPS panel URL. Localhost is only reachable on your own computer.",
  MACHINE_LIMIT: "This deployment has reached its machine limit.",
  INVALID_OR_EXPIRED_CODE: "That code is invalid, expired, or already used.",
  SETUP_OR_RECOVERY_REQUIRED:
    "Your setup session expired. Request a new code from your deployment administrator.",
  LAST_PASSKEY: "Add another passkey before removing your last one.",
  REAUTH_REQUIRED: "Verify your identity with a passkey, then try again.",
  TOO_MANY_ATTEMPTS: "Too many attempts. Wait a minute, then try again.",
  PASSKEY_LIMIT: "You can register up to ten passkeys.",
  UNAUTHORIZED: "Your session has ended. Please sign in again.",
};
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (
      response.status === 401 &&
      (path.startsWith("/security") ||
        path.startsWith("/machines") ||
        path === "/session")
    ) {
      if (!location.pathname.match(/^\/(login|setup|recover)$/))
        location.replace("/login");
    }
    throw new Error(
      messages[data.code] ??
        "The request could not be completed. Please try again.",
    );
  }
  return data as T;
}
export async function signIn() {
  const result = await authClient.signIn.passkey();
  if (result.error)
    throw new Error(
      result.error.message ?? "Passkey verification was cancelled or failed.",
    );
}
export async function addPasskey(name: string, createSession = false) {
  const result = await authClient.passkey.addPasskey({ name, createSession });
  if (result.error)
    throw new Error(
      result.error.message ?? "Passkey creation was cancelled or failed.",
    );
}
