import formbody from "@fastify/formbody";
import { validateContent, type ContentBundle, type ContentSource } from "@knight/content";
import { buildBundle } from "@knight/content/node";
import { KnightProfile, Outbox, validateStatement, type Statement } from "@knight/xapi";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { ServerConfig } from "./config.js";
import { AgsClient, AgsError } from "./lti/ags.js";
import type { IdentityStore } from "./lti/identity.js";
import type { ToolKeys } from "./lti/keys.js";
import { buildAuthRedirect, LoginStateStore, LtiError, verifyLaunch, type LoginRequest } from "./lti/launch.js";
import type { PlatformRegistry } from "./lti/platforms.js";
import type { ScoreStore } from "./scores.js";
import type { Session, SessionTokens } from "./session.js";

export interface AppDeps {
  config: ServerConfig;
  bundle: ContentBundle;
  outbox: Outbox;
  tokens: SessionTokens;
  platforms: PlatformRegistry;
  loginStates: LoginStateStore;
  identities: IdentityStore;
  ags: AgsClient;
  scores: ScoreStore;
  toolKeys: ToolKeys;
}

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
  }
}

const MAX_STATEMENTS_PER_POST = 200;

export async function buildApp(d: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", bodyLimit: 5 * 1024 * 1024 });
  await app.register(formbody);
  const profile = new KnightProfile(d.config.xapiBaseIri);
  let bundle = d.bundle;

  const requireSession = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const session = header?.startsWith("Bearer ") ? await d.tokens.verify(header.slice(7)) : undefined;
    if (!session) return reply.code(401).send({ error: "session required" });
    req.session = session;
  };

  app.get("/health", async () => ({ ok: true, content_hash: bundle.content_hash }));

  // ---------- Content API
  app.get("/content/bundle", async (req, reply) => {
    const etag = `"${bundle.content_hash}"`;
    reply.header("ETag", etag).header("Cache-Control", "no-cache");
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    return bundle;
  });

  app.get("/content/manifest", async () => ({ content_hash: bundle.content_hash, built_at: bundle.built_at }));

  /** Replaces the live content with a validated source tree. Invalid content never replaces a working bundle. */
  app.put<{ Body: ContentSource }>("/content/source", async (req, reply) => {
    if (!d.config.adminToken || req.headers.authorization !== `Bearer ${d.config.adminToken}`) {
      return reply.code(d.config.adminToken ? 401 : 403).send({ error: "content uploads are disabled or unauthorized" });
    }
    const result = validateContent(req.body);
    if (!result.ok || !result.content) return reply.code(422).send({ error: "content invalid", issues: result.issues });
    bundle = buildBundle(result.content);
    return { content_hash: bundle.content_hash, warnings: result.issues };
  });

  // ---------- Sessions
  app.post("/session/guest", async (_req, reply) => {
    if (!d.config.allowGuest) return reply.code(403).send({ error: "guest sessions are disabled" });
    const session: Session = { playerId: `guest_${crypto.randomUUID().slice(0, 8)}`, registration: crypto.randomUUID() };
    return { token: await d.tokens.issue(session), player_id: session.playerId, registration: session.registration };
  });

  // ---------- xAPI intake: the client's offline queue drains here, the server outbox delivers to the LRS.
  app.post<{ Body: unknown }>("/xapi/statements", { preHandler: requireSession }, async (req, reply) => {
    const body = Array.isArray(req.body) ? req.body : [req.body];
    if (body.length > MAX_STATEMENTS_PER_POST) return reply.code(413).send({ error: `at most ${MAX_STATEMENTS_PER_POST} statements per request` });
    const accepted: Statement[] = [];
    const rejected: { index: number; errors: string[] }[] = [];
    body.forEach((raw, index) => {
      const v = validateStatement(raw);
      if (!v.ok) return rejected.push({ index, errors: v.errors });
      const { account } = v.statement.actor;
      // The client may only write statements about its own session's player.
      if (account.homePage !== profile.accountHomePage || account.name !== req.session!.playerId) {
        return rejected.push({ index, errors: ["actor does not match the session"] });
      }
      accepted.push(v.statement);
    });
    if (rejected.length) return reply.code(400).send({ error: "invalid statements", rejected });
    const added = await d.outbox.enqueue(accepted);
    void d.outbox.flush().catch((e) => app.log.error(e, "xAPI flush failed"));
    return reply.code(202).send({ accepted: accepted.length, new: added, ids: accepted.map((s) => s.id) });
  });

  // ---------- Module result → best score → LTI AGS.
  // The client records the matching xAPI passed/failed statement itself (LearningEngine.moduleResult),
  // so the LRS has one statement per boss fight; this endpoint only feeds the LMS gradebook.
  app.post<{ Body: { module_id: string; correct: number; total: number } }>(
    "/progress/module-result",
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: "object",
          required: ["module_id", "correct", "total"],
          properties: {
            module_id: { type: "string" },
            correct: { type: "integer", minimum: 0 },
            total: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const s = req.session!;
      const module = bundle.modules.find((m) => m.module_id === req.body.module_id);
      if (!module) return reply.code(404).send({ error: "unknown module" });
      if (req.body.correct > req.body.total) return reply.code(400).send({ error: "correct > total" });
      const scaled = req.body.correct / req.body.total;
      const passed = scaled >= module.mastery.pass_score;
      const { best, improved } = await d.scores.record(s.playerId, module.module_id, scaled);

      let lms: "sent" | "not_lti" | "not_improved" | "failed" = "not_lti";
      if (s.lti?.ags && improved) {
        const platform = d.platforms.find(s.lti.iss, s.lti.clientId);
        try {
          if (!platform) throw new AgsError("platform no longer registered");
          const lineItem = await d.ags.lineItemFor(platform, s.lti.ags, { moduleId: module.module_id, label: module.title.en, scoreMaximum: 100 }, s.lti.moduleId);
          await d.ags.submitScore(platform, lineItem, {
            userId: s.lti.sub,
            scoreGiven: Math.round(best * 100),
            scoreMaximum: 100,
            activityProgress: "Completed",
            gradingProgress: "FullyGraded",
            timestamp: new Date().toISOString(),
          });
          lms = "sent";
        } catch (e) {
          // The grade is not lost: the best score is stored and is sent again on the next result.
          // A retry queue for AGS, like the xAPI outbox, comes with Postgres in week 5.
          req.log.error(e, "AGS score submission failed");
          lms = "failed";
        }
      } else if (s.lti?.ags) {
        lms = "not_improved";
      }
      return { passed, scaled, best, lms };
    },
  );

  // ---------- LTI 1.3 tool endpoints
  const launchUrl = `${d.config.publicUrl}/lti/launch`;

  const login = async (req: FastifyRequest<{ Querystring: LoginRequest; Body: LoginRequest }>, reply: FastifyReply) => {
    const params = { ...(req.query ?? {}), ...((req.body as LoginRequest | undefined) ?? {}) };
    try {
      return reply.redirect(buildAuthRedirect(params, d.platforms, d.loginStates, launchUrl), 302);
    } catch (e) {
      return ltiFailure(reply, e);
    }
  };
  app.get("/lti/login", login);
  app.post("/lti/login", login);

  app.post<{ Body: { id_token?: string; state?: string } }>("/lti/launch", async (req, reply) => {
    try {
      const launch = await verifyLaunch(req.body ?? {}, d.platforms, d.loginStates);
      const playerId = await d.identities.playerFor(launch.iss, launch.sub);
      const session: Session = {
        playerId,
        registration: crypto.randomUUID(),
        lti: {
          iss: launch.iss,
          clientId: launch.clientId,
          deploymentId: launch.deploymentId,
          sub: launch.sub,
          ...(launch.contextId ? { contextId: launch.contextId } : {}),
          ...(launch.ags ? { ags: launch.ags } : {}),
          ...(launch.custom.module_id ? { moduleId: launch.custom.module_id } : {}),
        },
      };
      const token = await d.tokens.issue(session);
      const target = new URL(d.config.clientUrl);
      // In the fragment, so the token never reaches server logs or Referer headers.
      target.hash = new URLSearchParams({ session: token, ...(session.lti?.moduleId ? { module: session.lti.moduleId } : {}) }).toString();
      return reply.type("text/html").send(redirectPage(target.toString()));
    } catch (e) {
      return ltiFailure(reply, e);
    }
  });

  app.get("/.well-known/jwks.json", async () => ({ keys: [d.toolKeys.publicJwk] }));

  return app;
}

function ltiFailure(reply: FastifyReply, e: unknown) {
  if (e instanceof LtiError) return reply.code(e.status).send({ error: e.code, message: e.message });
  throw e;
}

function redirectPage(url: string): string {
  const safe = url.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safe}"><title>Knight of Words</title></head><body><a href="${safe}">Continue to the game</a></body></html>`;
}
