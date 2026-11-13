# Authentication

Tenet has a single owner per installation. Better Auth and its passkey plugin run
inside the shared API; no Better Auth account, hosted auth service, email provider,
or social-login credentials are required. Team invitations and roles are not yet
implemented. The owner will eventually control all enrolled machines.

## First setup

Choose the final dashboard hostname before enrolling passkeys. WebAuthn binds
credentials to that hostname. Production requires HTTPS; HTTP is accepted only
for `localhost` development. `TENET_ORIGIN` is an exact origin without a trailing
slash. Never derive it from a request's Host or forwarded headers.

For PostgreSQL development:

1. Install dependencies with `bun install --frozen-lockfile`.
2. Create a PostgreSQL database. Copy `apps/server/.env.example` to
   `apps/server/.env`, set `DATABASE_URL`, and generate `BETTER_AUTH_SECRET` using
   `openssl rand -hex 32`. Keep the secret stable across restarts and replicas.
3. Apply migrations and issue a short-lived setup code:

   ```sh
   bun --env-file=apps/server/.env run auth:admin migrate
   bun --env-file=apps/server/.env run auth:admin setup
   ```

4. Run `bun run dev` and open `http://localhost:3000`. Enter your name and setup
   code, then create a passkey. Your authenticator must support resident
   credentials and user verification (PIN, biometrics, or equivalent).
5. In **Security**, generate recovery codes and save them in a password manager
   or offline. Register another passkey on a separate device/security key.

The setup code expires after 30 minutes and is consumed when exchanged for a
10-minute HttpOnly enrollment cookie. It is never put in a URL. Issuing another
setup code replaces any pending setup code and enrollment grant. Once configured,
the setup command refuses to issue more codes. There is no public signup.

See `deploy/cloudflare/README.md` for D1, and `deploy/docker/README.md` or
`deploy/railway/README.md` for production hosting.

## Recovery and session management

A recovery code is a high-entropy, single-use bearer credential. Only its SHA-256
hash is stored. Starting recovery immediately invalidates all existing sessions
and passkeys, then permits registration of a replacement passkey. Remaining unused
codes continue to work; generate a new set after recovery if old codes may have
been exposed. Generating a new set invalidates every previous code. The plaintext
codes are returned once and kept only in the current page's memory.

If all passkeys and recovery codes are lost, a deployment administrator with database
access can run:

```sh
bun --env-file=apps/server/.env run auth:admin recover
# Or for D1:
bun run auth:admin recover --worker --remote
```

This replaces the saved recovery codes with one new code. It does not bypass
WebAuthn or create a session. Use it on `/recover`. Issuing a code alone does not
revoke sessions; consuming it does. Protect shell access, database credentials,
and deployment permissions as carefully as the owner account.

Sessions expire after eight hours without sliding renewal. They are stored in the
database, never cached in a cookie or local storage. The browser receives a signed
HttpOnly, SameSite=Strict cookie; production cookies also use Secure and the
`__Host-` prefix. Session tokens are stripped from JSON responses.

Adding/removing passkeys, rotating recovery codes, and revoking other sessions
require a passkey authentication within five minutes. Use **Verify identity** to
reauthenticate. Removing a passkey signs out every other session and preserves the
session making the change. The last usable passkey cannot be removed. Recovery
is the supported way to replace a lost final passkey. Signing out deletes the
current database session; replaying its cookie fails immediately.

## Security boundaries

- Every private API route is behind authoritative session and owner checks.
  Frontend route guards are navigation aids, never the authorization boundary.
  Add future machine/service endpoints after the shared authorization middleware.
- Only explicitly allowed Better Auth endpoints are exposed. Password login,
  public signup, arbitrary user updates, account linking, and user deletion are
  unavailable. A future feature must deliberately extend this policy.
- WebAuthn checks the exact origin, RP ID, signature, challenge, and user
  verification. Better Auth consumes challenges once. Registration is bound to
  either a fresh session or the exact deployment/recovery grant that initiated it.
- A database compare-and-swap protects setup/recovery secrets, credential policy,
  and recovery-code rotation across processes. A monotonically increasing epoch
  invalidates existing sessions and in-flight authentication proofs during
  recovery or credential removal. No authorization decisions live in global
  request state or eventually consistent storage.
- All mutation requests require the exact configured Origin and JSON. There is
  no cross-origin CORS allowance. Bodies are limited to 32 KiB. Database-backed
  rate limits survive restarts and apply across replicas.
- The conventional server deliberately ignores client-supplied forwarding headers
  and uses a shared limiter bucket. Workers use Cloudflare's client IP header.
  Apply perimeter limits as well on publicly reachable deployments; shared/global
  buckets prioritize resisting brute force over availability during an attack.
- The private dashboard is a TanStack Start SPA served with the API on one origin.
  No owner data is baked into HTML. Production CSP allows same-origin assets and
  exact hashes for generated inline startup scripts; framing and external
  connections are blocked. Rebuild header hashes with every frontend build.
- The audit log records setup, recovery, passkey and session events without codes,
  cookies, or private keys. It is an operational log in the same database, not a
  tamper-proof external audit system. The dashboard shows the latest 50 events.
- Future daemon identities must use separate machine-scoped credentials; never
  give daemons an owner's browser session or deployment auth secret.

D1 cannot wrap all enrollment work in a general SQL transaction. Tenet deliberately
fails closed if enrollment is interrupted between policy updates and credential
persistence: a pending setup can be restarted with `auth:admin setup`; a configured
installation can be repaired using deployment-level recovery. PostgreSQL and D1
use the same policy so their security semantics do not diverge. Do not restore a
stale auth database backup onto a live installation without considering that it
can restore previously revoked sessions or recovery codes; rotate the auth secret
and perform owner recovery after such a restore.

## Operations and verification

Back up the database and deployment secret securely. Keep auth dependencies pinned
with the shipped schema; review release notes and generate/review migrations when
upgrading Better Auth. Deploy migrations before new application code. Never use
schema auto-sync on a live database.

Run periodically to delete expired sessions/challenges/rate-limit buckets and
retain 90 days of security activity:

```sh
bun --env-file=apps/server/.env run auth:admin cleanup
bun run auth:admin cleanup --worker --remote
```

The rate-limit and audit tables need this maintenance on long-running installations.
No automatic external scheduler is created by this repository.

```sh
bun run test                                      # In-memory SQLite, real WebAuthn signatures
TEST_DATABASE_URL=postgres://... bun run test     # Disposable schemas in a test PostgreSQL DB
bun run check
bun run build
```

The suite covers setup expiry/replay, origin and content-type checks, registration
binding, user verification, WebAuthn replay, session expiration/revocation,
recovery, fresh-auth requirements, durable limits and concurrent last-key removal.
Use a dedicated test database: tests create and drop their own randomly named
schemas. Browser checks should exercise real/virtual WebAuthn enrollment,
sign-in, security controls, and recovery on both runtime distributions.
