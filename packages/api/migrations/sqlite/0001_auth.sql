-- Better Auth / passkey 1.7.22 schema, followed by Tenet policy tables.
create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade, "authEpoch" integer not null);

create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create table "passkey" ("id" text not null primary key, "name" text, "publicKey" text not null, "userId" text not null references "user" ("id") on delete cascade, "credentialID" text not null, "counter" integer not null, "deviceType" text not null, "backedUp" integer not null, "transports" text, "createdAt" date, "aaguid" text);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

create index "passkey_userId_idx" on "passkey" ("userId");

create index "passkey_credentialID_idx" on "passkey" ("credentialID");

-- Tenet policy state is updated atomically with a revision compare-and-swap.
CREATE UNIQUE INDEX passkey_credential_unique ON passkey ("credentialID");
CREATE TABLE tenet_auth_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL);
INSERT INTO tenet_auth_state VALUES (1, '{"configured":false,"name":"Owner","epoch":0,"credentials":[],"recovery":[]}', 0);
CREATE TABLE tenet_auth_rate (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, reset_at BIGINT NOT NULL);
CREATE INDEX tenet_auth_rate_expiry ON tenet_auth_rate (reset_at);
CREATE TABLE tenet_auth_audit (id TEXT PRIMARY KEY, event TEXT NOT NULL, subject TEXT, occurred_at BIGINT NOT NULL);
CREATE INDEX tenet_auth_audit_time ON tenet_auth_audit (occurred_at);
