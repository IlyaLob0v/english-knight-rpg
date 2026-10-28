import { readFileSync } from "node:fs";
import type { PlatformConfig } from "./lti/platforms.js";

export interface ServerConfig {
  port: number;
  host: string;
  /** Public URL of this server, used for LTI redirect_uri and JWKS. */
  publicUrl: string;
  /** Where the game client lives; LTI launches redirect there with a session token. */
  clientUrl: string;
  contentDir: string;
  /** xAPI base IRI; must be a domain you control and must never change once data exists. */
  xapiBaseIri: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  /** Bearer token for content uploads. Unset = uploads disabled. */
  adminToken?: string;
  /** Allows POST /session/guest for local play without an LMS. Never in production. */
  allowGuest: boolean;
  lrs?: { endpoint: string; key: string; secret: string };
  /** Postgres for the gateway's state. Unset = in-memory stores (dev only: a restart forgets everything). */
  databaseUrl?: string;
  lti: {
    platforms: PlatformConfig[];
    /** PEM (PKCS#8) RSA private key of the tool. Unset = an ephemeral key is generated (dev only). */
    privateKeyPem?: string;
    keyId: string;
  };
}

function required(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const v = env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing env ${name}`);
  return v;
}

/** A value from NAME, or from the file NAME_FILE points to (Docker secrets, generated dev files). */
function fromEnvOrFile(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name]) return env[name];
  const file = env[`${name}_FILE`];
  return file ? readFileSync(file, "utf8") : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === "production";
  const sessionSecret = required(env, "SESSION_SECRET", production ? undefined : "dev-only-session-secret-change-me-0123456789");
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const port = Number(env.PORT ?? 8787);
  if (production && !env.DATABASE_URL) throw new Error("DATABASE_URL is required when NODE_ENV=production");
  const platforms = fromEnvOrFile(env, "LTI_PLATFORMS");
  const privateKeyPem = fromEnvOrFile(env, "LTI_PRIVATE_KEY");
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    clientUrl: env.CLIENT_URL ?? "http://localhost:5173",
    contentDir: env.CONTENT_DIR ?? new URL("../../../content", import.meta.url).pathname,
    xapiBaseIri: env.XAPI_BASE_IRI ?? "https://moonbridge.example.com",
    sessionSecret,
    sessionTtlSeconds: Number(env.SESSION_TTL_SECONDS ?? 8 * 3600),
    ...(env.ADMIN_TOKEN ? { adminToken: env.ADMIN_TOKEN } : {}),
    allowGuest: !production && env.ALLOW_GUEST !== "false",
    ...(env.LRS_ENDPOINT
      ? { lrs: { endpoint: env.LRS_ENDPOINT, key: required(env, "LRS_KEY"), secret: required(env, "LRS_SECRET") } }
      : {}),
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    lti: {
      platforms: platforms ? (JSON.parse(platforms) as PlatformConfig[]) : [],
      ...(privateKeyPem ? { privateKeyPem } : {}),
      keyId: env.LTI_KEY_ID ?? "moonbridge-tool-1",
    },
  };
}
