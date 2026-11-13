import { passkey } from "@better-auth/passkey";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { AuthError, AuthStore, FRESH_MS, OWNER_ID, type Sql } from "./store";

export interface AuthEnvironment {
  origin: string;
  secret: string;
  database: BetterAuthOptions["database"];
  sql: Sql;
  releaseUrl?: string;
  releasePublicKey?: string;
  loadDaemonRelease?: () => Promise<unknown>;
}

export function validateConfig(env: AuthEnvironment) {
  const url = new URL(env.origin);
  if (
    url.origin !== env.origin ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname === "localhost"))
  )
    throw new Error(
      "TENET_ORIGIN must be an HTTPS origin (HTTP localhost is allowed for development).",
    );
  if (env.releaseUrl || env.releasePublicKey) {
    const source = new URL(env.releaseUrl || "invalid");
    if (
      source.protocol !== "https:" ||
      source.username ||
      source.password ||
      source.hash ||
      !/^[a-f0-9]{64}$/.test(env.releasePublicKey || "")
    )
      throw new Error(
        "Configure both TENET_RELEASE_URL (HTTPS) and TENET_RELEASE_PUBLIC_KEY (64 lowercase hex characters).",
      );
  }
  if (env.secret.length < 64 || new Set(env.secret).size < 16)
    throw new Error(
      "BETTER_AUTH_SECRET must be a securely generated secret of at least 64 characters.",
    );
  return { secure: url.protocol === "https:", rpID: url.hostname };
}

export function grantCookieName(origin: string) {
  return origin.startsWith("https:") ? "__Host-tenet.grant" : "tenet.grant";
}
export function cookie(headers: Headers, name: string) {
  return headers
    .get("cookie")
    ?.split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** Request scoped: verifiedEpoch must never be shared between concurrent requests. */
export function createAuth(
  env: AuthEnvironment,
  requestHeaders = new Headers(),
) {
  const { secure, rpID } = validateConfig(env);
  const store = new AuthStore(env.sql);
  let verifiedEpoch: number | undefined;
  const grantToken = cookie(requestHeaders, grantCookieName(env.origin));

  const auth = betterAuth({
    appName: "Tenet",
    baseURL: env.origin,
    basePath: "/api/auth",
    secret: env.secret,
    database: env.database,
    trustedOrigins: [env.origin],
    emailAndPassword: { enabled: false },
    rateLimit: { enabled: false }, // Shared atomic SQL limiter at the API boundary.
    session: {
      expiresIn: 8 * 60 * 60,
      freshAge: FRESH_MS / 1000,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: {
        authEpoch: {
          type: "number",
          required: true,
          defaultValue: -1,
          input: false,
        },
      },
    },
    advanced: {
      useSecureCookies: false, // Names below use the stronger __Host- prefix in production.
      cookiePrefix: secure ? "__Host-tenet" : "tenet",
      defaultCookieAttributes: {
        secure,
        httpOnly: true,
        sameSite: "strict",
        path: "/",
      },
      ipAddress: { disableIpTracking: true },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const { state } = await store.read();
            if (
              verifiedEpoch === undefined ||
              verifiedEpoch !== state.epoch ||
              session.userId !== OWNER_ID ||
              !state.configured
            )
              return false;
            return { data: { ...session, authEpoch: verifiedEpoch } };
          },
        },
      },
    },
    plugins: [
      passkey({
        rpID,
        rpName: "Tenet",
        origin: env.origin,
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        registration: {
          requireSession: false,
          resolveUser: async () => {
            const { state } = await store.grant(grantToken);
            return { id: OWNER_ID, name: state.name, displayName: state.name };
          },
          afterVerification: async ({ ctx, verification, context }) => {
            const credentialID = verification.registrationInfo?.credential.id;
            if (!credentialID) throw new APIError("UNAUTHORIZED");
            // A failed duplicate insert must never reauthorize a previously revoked key.
            if (
              (
                await env.sql.query(
                  'SELECT id FROM passkey WHERE "credentialID" = $1',
                  [credentialID],
                )
              ).length
            )
              throw new APIError("CONFLICT", {
                message:
                  "This credential is already registered. Create a new passkey.",
              });
            const session = await auth.api.getSession({
              headers: requestHeaders,
            });
            let digest: string | undefined;
            if (session) await requireOwner(auth, store, requestHeaders, true);
            else {
              const grant = await store.grant(grantToken);
              digest = grant.digest;
              if (context !== digest) throw new APIError("UNAUTHORIZED");
            }
            const result = await store.change((s) => {
              if (session) {
                if (session.session.authEpoch !== s.epoch)
                  throw new AuthError("UNAUTHORIZED", 401);
              } else {
                if (
                  !s.grant ||
                  s.grant.hash !== digest ||
                  s.grant.expires <= Date.now() ||
                  s.grant.epoch !== s.epoch
                )
                  throw new AuthError("INVALID_OR_EXPIRED_CODE", 401);
                delete s.grant;
              }
              if (
                s.credentials.length >= 10 ||
                s.credentials.includes(credentialID)
              )
                throw new AuthError("PASSKEY_LIMIT", 409);
              s.credentials.push(credentialID);
              s.configured = true;
              return { epoch: s.epoch, name: s.name };
            });
            if (!(await ctx.context.internalAdapter.findUserById(OWNER_ID))) {
              await ctx.context.internalAdapter.createUser(
                {
                  id: OWNER_ID,
                  name: result.name,
                  email: "owner@tenet.invalid",
                  emailVerified: false,
                },
                { method: "passkey" },
              );
            }
            verifiedEpoch = result.epoch;
            await store.audit("passkey.registered", credentialID);
            return { userId: OWNER_ID };
          },
        },
        authentication: {
          afterVerification: async ({ clientData }) => {
            const { state } = await store.read();
            if (!state.configured || !state.credentials.includes(clientData.id))
              throw new APIError("UNAUTHORIZED", {
                message: "Passkey has been revoked.",
              });
            verifiedEpoch = state.epoch;
          },
        },
      }),
    ],
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
export async function requireOwner(
  auth: Auth,
  store: AuthStore,
  headers: Headers,
  fresh = false,
) {
  const session = await auth.api.getSession({ headers });
  const { state } = await store.read();
  if (
    !session ||
    !state.configured ||
    session.user.id !== OWNER_ID ||
    session.session.authEpoch !== state.epoch
  )
    throw new AuthError("UNAUTHORIZED", 401);
  if (
    fresh &&
    Date.now() - new Date(session.session.createdAt).getTime() >= FRESH_MS
  )
    throw new AuthError("REAUTH_REQUIRED", 403);
  return session;
}
