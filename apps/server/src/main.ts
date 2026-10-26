import { validateContent } from "@knight/content";
import { buildBundle, loadContentDir } from "@knight/content/node";
import { LrsClient, MemoryOutboxStore, Outbox, type StatementSink } from "@knight/xapi";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { AgsClient } from "./lti/ags.js";
import { MemoryIdentityStore } from "./lti/identity.js";
import { loadToolKeys } from "./lti/keys.js";
import { LoginStateStore } from "./lti/launch.js";
import { PlatformRegistry } from "./lti/platforms.js";
import { MemoryScoreStore } from "./scores.js";
import { SessionTokens } from "./session.js";

const config = loadConfig();

const { source, parseErrors } = await loadContentDir(config.contentDir);
const result = validateContent(source);
if (parseErrors.length || !result.ok || !result.content) {
  console.error("Content is invalid; run `pnpm content:validate`.", parseErrors, result.issues);
  process.exit(1);
}

// Without an LRS, statements stay queued (and are logged) until one is configured.
const sink: StatementSink = config.lrs
  ? new LrsClient(config.lrs)
  : { send: async () => ({ kind: "retry", reason: "no LRS configured" }) };
const outbox = new Outbox(new MemoryOutboxStore(), sink);
const toolKeys = await loadToolKeys(config.lti.keyId, config.lti.privateKeyPem);

const app = await buildApp({
  config,
  bundle: buildBundle(result.content),
  outbox,
  tokens: new SessionTokens(config.sessionSecret, config.sessionTtlSeconds),
  platforms: new PlatformRegistry(config.lti.platforms),
  loginStates: new LoginStateStore(),
  identities: new MemoryIdentityStore(),
  ags: new AgsClient(toolKeys),
  scores: new MemoryScoreStore(),
  toolKeys,
});

const timer = setInterval(() => void outbox.flush().catch((e) => app.log.error(e, "xAPI flush failed")), 10_000);
app.addHook("onClose", async () => clearInterval(timer));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());

if (!config.lrs) app.log.warn("LRS_ENDPOINT is not set: xAPI statements are queued in memory only");
if (!config.lti.privateKeyPem) app.log.warn("LTI_PRIVATE_KEY is not set: using an ephemeral tool key (dev only)");
await app.listen({ port: config.port, host: config.host });
