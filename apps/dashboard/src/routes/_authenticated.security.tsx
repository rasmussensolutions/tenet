import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addPasskey, api, signIn } from "@/lib/auth";

interface Security {
  passkeys: {
    id: string;
    name: string | null;
    createdAt: string | number;
    backedUp: boolean;
  }[];
  sessions: {
    id: string;
    createdAt: string | number;
    expiresAt: string | number;
    userAgent: string | null;
    current: boolean;
  }[];
  audit: { id: string; event: string; occurred_at: number }[];
  recoveryCodesRemaining: number;
}
export const Route = createFileRoute("/_authenticated/security")({
  loader: () => api<Security>("/security"),
  component: SecurityPage,
});

function SecurityPage() {
  const router = useRouter();
  const data = Route.useLoaderData();
  const [name, setName] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await router.invalidate();
      setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsPage
      title="Security"
      description="Manage how you sign in and recover access to Tenet."
    >
      {(error || notice) && (
        <div className="space-y-1 rounded-lg border bg-card px-4 py-3 text-sm text-card-foreground sm:px-5">
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
        </div>
      )}

      <SettingsSection title="Passkeys">
        <SettingsGroup>
          <SettingsRow
            title="Identity verification"
            description="Verify with a passkey to make security changes for five minutes."
            control={
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  run(signIn, "Identity verified for five minutes.")
                }
              >
                Verify identity
              </Button>
            }
          />
          {data.passkeys.map((key) => (
            <SettingsRow
              key={key.id}
              title={key.name || "Passkey"}
              description={`Added ${new Date(key.createdAt).toLocaleDateString()}`}
              control={
                <Button
                  variant="ghost"
                  aria-label={`Remove ${key.name || "passkey"}`}
                  disabled={busy || data.passkeys.length < 2}
                  onClick={() => {
                    if (
                      confirm(
                        `Remove “${key.name || "Passkey"}”? All other sessions will be signed out.`,
                      )
                    )
                      void run(
                        () => api("/security/passkeys/remove", { id: key.id }),
                        "Passkey removed.",
                      );
                  }}
                >
                  Remove
                </Button>
              }
            />
          ))}
          <SettingsRow
            title="Add a passkey"
            description="Keep a backup on a separate device or security key."
            control={
              <form
                className="flex max-w-xs flex-wrap gap-2 @lg:flex-nowrap"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    await addPasskey(name.trim());
                    setName("");
                  }, "Passkey added.");
                }}
              >
                <label htmlFor="new-passkey" className="sr-only">
                  New passkey name
                </label>
                <Input
                  id="new-passkey"
                  className="w-40 max-w-full"
                  placeholder="Passkey name"
                  value={name}
                  maxLength={80}
                  required
                  onChange={(event) => setName(event.target.value)}
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={busy || !name.trim()}
                >
                  Add passkey
                </Button>
              </form>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Recovery codes">
        <SettingsGroup>
          <SettingsRow
            title={`${data.recoveryCodesRemaining} unused ${data.recoveryCodesRemaining === 1 ? "code" : "codes"}`}
            description="Save codes offline or in a password manager. Using a code lets you replace your passkeys and signs out all sessions."
            control={
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (
                    data.recoveryCodesRemaining &&
                    !confirm(
                      "Generate new recovery codes? All previous recovery codes will stop working.",
                    )
                  )
                    return;
                  void run(async () => {
                    const result = await api<{ codes: string[] }>(
                      "/security/recovery-codes",
                      {},
                    );
                    setCodes(result.codes);
                  }, "New recovery codes generated.");
                }}
              >
                Generate recovery codes
              </Button>
            }
          />
          {codes.length > 0 && (
            <SettingsRow
              title="Save your recovery codes"
              description="These codes are shown only once."
            >
              <pre className="overflow-x-auto rounded-lg border bg-background px-3 py-2 font-mono text-xs leading-6 select-all">
                {codes.join("\n")}
              </pre>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(codes.join("\n"));
                      setError("");
                      setNotice("Recovery codes copied.");
                    } catch {
                      setNotice("");
                      setError(
                        "Copy failed. Select and copy the codes manually.",
                      );
                    }
                  }}
                >
                  Copy codes
                </Button>
                <Button onClick={() => setCodes([])}>I saved my codes</Button>
              </div>
            </SettingsRow>
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Active sessions">
        <SettingsGroup>
          {data.sessions.map((session) => (
            <SettingsRow
              key={session.id}
              title={session.current ? "This session" : "Browser session"}
              description={
                <>
                  <p
                    className="truncate"
                    title={session.userAgent ?? undefined}
                  >
                    {session.userAgent ?? "Unknown browser"}
                  </p>
                  <p>Expires {new Date(session.expiresAt).toLocaleString()}</p>
                </>
              }
              control={
                session.current ? (
                  <span className="inline-flex rounded-md border bg-background px-2 py-0.5 text-xs text-muted-foreground">
                    Current
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () =>
                          api("/security/sessions/revoke", { id: session.id }),
                        "Session signed out.",
                      )
                    }
                  >
                    Revoke
                  </Button>
                )
              }
            />
          ))}
          <SettingsRow
            title="Other sessions"
            description="Keep this session and sign out everywhere else."
            control={
              <Button
                variant="outline"
                disabled={
                  busy || !data.sessions.some((session) => !session.current)
                }
                onClick={() =>
                  run(
                    () => api("/security/sessions/revoke", { id: "others" }),
                    "Other sessions signed out.",
                  )
                }
              >
                Sign out other sessions
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Recent security activity">
        <SettingsGroup>
          {data.audit.length === 0 && (
            <SettingsRow title="No security activity yet" />
          )}
          {data.audit.map((event) => {
            const date = new Date(event.occurred_at);
            return (
              <SettingsRow
                key={event.id}
                title={
                  auditLabels[event.event] ??
                  event.event.replaceAll(".", " · ").replaceAll("_", " ")
                }
                control={
                  <time
                    className="text-xs text-muted-foreground"
                    dateTime={date.toISOString()}
                  >
                    {date.toLocaleString()}
                  </time>
                }
              />
            );
          })}
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}

const auditLabels: Record<string, string> = {
  "setup.issued": "Setup code issued",
  "setup.started": "Owner setup started",
  "setup.rejected": "Setup code rejected",
  "passkey.registered": "Passkey added",
  "passkey.removed": "Passkey removed",
  "recovery.started": "Account recovery started",
  "recovery.rejected": "Recovery code rejected",
  "recovery.codes_rotated": "Recovery codes generated",
  "recovery.operator_issued": "Administrator recovery code issued",
  "session.signed_in": "Signed in",
  "session.sign_in_rejected": "Sign-in attempt rejected",
  "session.signed_out": "Signed out",
  "session.revoked": "Session revoked",
};
