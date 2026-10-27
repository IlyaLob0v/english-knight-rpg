import { validateContent } from "@moonbridge/content";
import { buildBundle, loadContentDir } from "@moonbridge/content/node";
import { LrsClient, MemoryOutboxStore, Outbox, type StatementSink } from "@moonbridge/xapi";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { connectPostgres, migrate } from "./db/sql.js";
import { PgGradeStore, PgIdentityStore, PgLoginStates, PgOutboxStore, PgProgressStore, PgScoreStore } from "./db/stores.js";
import { GradeSync, MemoryGradeStore } from "./grades.js";
import { AgsClient } from "./lti/ags.js";
import { MemoryIdentityStore } from "./lti/identity.js";
import { loadToolKeys } from "./lti/keys.js";
import { LoginStateStore } from "./lti/launch.js";
import { PlatformRegistry } from "./lti/platforms.js";
import { MemoryProgressStore } from "./progress.js";
import { MemoryScoreStore } from "./scores.js";
import { SessionTokens } from "./session.js";

const config = loadConfig();

const { source, parseErrors } = await loadContentDir(config.contentDir);
const result = validateContent(source);
if (parseErrors.length || !result.ok || !result.content) {
  console.error("Content is invalid; run `pnpm content:validate`.", parseErrors, result.issues);
  process.exit(1);
}

const db = config.databaseUrl ? connectPostgres(config.databaseUrl) : undefined;
if (db) {
  const applied = await migrate(db);
  if (applied.length) console.info(`database migrated: ${applied.join(", ")}`);
}
const stores = db
  ? {
      outbox: new PgOutboxStore(db),
      loginStates: new PgLoginStates(db),
      identities: new PgIdentityStore(db),
      scores: new PgScoreStore(db),
      grades: new PgGradeStore(db),
      progress: new PgProgressStore(db),
    }
  : {
      outbox: new MemoryOutboxStore(),
      loginStates: new LoginStateStore(),
      identities: new MemoryIdentityStore(),
      scores: new MemoryScoreStore(),
      grades: new MemoryGradeStore(),
      progress: new MemoryProgressStore(),
    };

// Without an LRS, statements stay queued until one is configured.
const sink: StatementSink = config.lrs
  ? new LrsClient(config.lrs)
  : { send: async () => ({ kind: "retry", reason: "no LRS configured" }) };
const outbox = new Outbox(stores.outbox, sink);
const toolKeys = await loadToolKeys(config.lti.keyId, config.lti.privateKeyPem);
const platforms = new PlatformRegistry(config.lti.platforms);

let log: (e: unknown, message: string) => void = (e, m) => console.error(m, e);
const grades = new GradeSync(stores.grades, platforms, new AgsClient(toolKeys), {}, (e, m) => log(e, m));

const app = await buildApp({
  config,
  bundle: buildBundle(result.content),
  outbox,
  tokens: new SessionTokens(config.sessionSecret, config.sessionTtlSeconds),
  platforms,
  loginStates: stores.loginStates,
  identities: stores.identities,
  grades,
  scores: stores.scores,
  progress: stores.progress,
  toolKeys,
});
log = (e, m) => app.log.warn({ err: e }, m);

const timers = [
  setInterval(() => void outbox.flush().catch((e) => app.log.error(e, "xAPI flush failed")), 10_000),
  setInterval(() => void grades.flush().catch((e) => app.log.error(e, "AGS flush failed")), 15_000),
];
app.addHook("onClose", async () => {
  timers.forEach(clearInterval);
  await db?.close();
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());

if (!db) app.log.warn("DATABASE_URL is not set: sessions, grades and the xAPI queue live in memory and are lost on restart");
if (!config.lrs) app.log.warn("LRS_ENDPOINT is not set: xAPI statements are queued but not delivered");
if (!config.lti.privateKeyPem) app.log.warn("LTI_PRIVATE_KEY is not set: using an ephemeral tool key (dev only)");
app.log.info(`LTI platforms: ${config.lti.platforms.map((p) => `${p.issuer} (${p.clientId})`).join(", ") || "none"}`);
await app.listen({ port: config.port, host: config.host });
