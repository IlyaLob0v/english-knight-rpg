import { basename, extname } from "node:path";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify, SignJWT } from "jose";
import type { ServerConfig } from "../config.js";
import type { Session, SessionTokens } from "../session.js";
import { FileTooLargeError, type FileStore } from "./files.js";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./passwords.js";
import { LoginTakenError, type Account, type Group, type Homework, type SchoolStore, type Submission } from "./store.js";

export interface SchoolDeps {
  config: ServerConfig;
  tokens: SessionTokens;
  school: SchoolStore;
  files: FileStore;
  now?: () => Date;
}

declare module "fastify" {
  interface FastifyRequest {
    account?: Account;
  }
}

/** A phone's voice memo or a few photos of a notebook fit comfortably. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const INVITE_DAYS = 14;
/** How long a file link stays valid: long enough to tap it, short enough not to matter if it leaks. */
const FILE_LINK_SECONDS = 300;

// What a student may hand in: recordings, photos, short videos and documents. Phones do not
// always say what a file is, so the extension decides when the type is missing.
const FILE_TYPES: Record<string, string> = {
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".amr": "audio/amr",
  ".3gp": "audio/3gpp",
  ".webm": "audio/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
};
const ACCEPTED_TYPES = new Set(Object.values(FILE_TYPES));

/** The file's type if a student may hand it in: by its declared type, else by its extension. */
export function acceptedType(declared: string | undefined, fileName: string): string | undefined {
  const type = (declared ?? "").split(";")[0]!.trim().toLowerCase();
  if (/^(audio|image|video)\/[\w.+-]+$/.test(type) || ACCEPTED_TYPES.has(type)) return type;
  return FILE_TYPES[extname(fileName).toLowerCase()];
}

const LOGIN = /^[a-z0-9._@+-]{3,64}$/;
const normalizeLogin = (s: string) => s.trim().toLowerCase();

const credentials = {
  type: "object",
  required: ["login", "password"],
  properties: { login: { type: "string", maxLength: 64 }, password: { type: "string", minLength: 1, maxLength: 128 } },
} as const;
const newAccount = {
  type: "object",
  required: ["name", "login", "password"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 60 },
    login: { type: "string", maxLength: 64 },
    password: { type: "string", minLength: 6, maxLength: 128 },
  },
} as const;
const slot = {
  type: "object",
  required: ["weekday", "time", "minutes"],
  additionalProperties: false,
  properties: {
    weekday: { type: "integer", minimum: 1, maximum: 7 },
    time: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
    minutes: { type: "integer", minimum: 15, maximum: 240 },
  },
} as const;
const groupFields = {
  name: { type: "string", minLength: 1, maxLength: 80 },
  call_url: { anyOf: [{ type: "string", pattern: "^https?://", maxLength: 500 }, { type: "null" }] },
  schedule: { type: "array", maxItems: 14, items: slot },
} as const;

interface NewAccountBody {
  name: string;
  login: string;
  password: string;
}
interface GroupBody {
  name?: string;
  call_url?: string | null;
  schedule?: Group["schedule"];
}

const accountView = (a: Account) => ({ id: a.accountId, name: a.name, role: a.role, login: a.login });
const submissionView = (s: Submission) => ({
  submission_id: s.submissionId,
  account_id: s.accountId,
  student_name: s.studentName,
  file_name: s.fileName,
  mime: s.mime,
  size: s.size,
  submitted_at: s.submittedAt.toISOString(),
});
const homeworkView = (h: Homework) => ({
  homework_id: h.homeworkId,
  group_id: h.groupId,
  title: h.title,
  description: h.description,
  due_at: h.dueAt?.toISOString() ?? null,
  needs_file: h.needsFile,
  created_at: h.createdAt.toISOString(),
});
const groupView = (g: Group) => ({ group_id: g.groupId, name: g.name, teacher_name: g.teacherName, call_url: g.callUrl, schedule: g.schedule });

/**
 * The school platform's accounts and groups: teachers are created by the admin, students
 * join a group by its invitation link, homework goes to the whole group, and a homework
 * that cannot be checked automatically is handed in as a file the teacher opens.
 */
export async function schoolRoutes(app: FastifyInstance, d: SchoolDeps): Promise<void> {
  const now = d.now ?? (() => new Date());

  const sessionOf = async (req: FastifyRequest): Promise<Session | undefined> => {
    const header = req.headers.authorization;
    return header?.startsWith("Bearer ") ? d.tokens.verify(header.slice(7)) : undefined;
  };

  const requireAccount = async (req: FastifyRequest, reply: FastifyReply) => {
    const session = await sessionOf(req);
    const account = session?.account && (await d.school.accountById(session.account.id));
    if (!session || !account) return reply.code(401).send({ error: "sign-in required" });
    req.session = session;
    req.account = account;
  };

  const requireTeacher = async (req: FastifyRequest, reply: FastifyReply) => {
    await requireAccount(req, reply);
    if (!reply.sent && req.account?.role !== "teacher") return reply.code(403).send({ error: "teachers only" });
  };

  /** The group, if the signed-in teacher runs it. */
  const ownGroup = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<Group | undefined> => {
    const g = await d.school.group(req.params.id);
    if (!g || g.teacherId !== req.account!.accountId) {
      reply.code(404).send({ error: "no such group" });
      return undefined;
    }
    return g;
  };

  const signIn = async (a: Account) => {
    const session: Session = { playerId: a.playerId, registration: crypto.randomUUID(), account: { id: a.accountId, role: a.role } };
    return { token: await d.tokens.issue(session, d.config.accountSessionTtlSeconds), player_id: a.playerId, registration: session.registration, account: accountView(a) };
  };

  const createAccount = async (role: Account["role"], body: NewAccountBody, reply: FastifyReply, playerId?: string) => {
    const login = normalizeLogin(body.login);
    if (!LOGIN.test(login)) {
      reply.code(400).send({ error: "login", message: "Логин: 3–64 латинские буквы, цифры, точка, дефис или e-mail" });
      return undefined;
    }
    try {
      return await d.school.createAccount({ role, name: body.name.trim(), login, passwordHash: await hashPassword(body.password), ...(playerId ? { playerId } : {}) });
    } catch (e) {
      if (!(e instanceof LoginTakenError)) throw e;
      reply.code(409).send({ error: "login_taken", message: "Такой логин уже занят" });
      return undefined;
    }
  };

  app.get("/auth/options", async () => ({ guest: d.config.allowGuest }));

  /** Teachers are created by whoever runs the school (ADMIN_TOKEN); students come through invitations. */
  app.post<{ Body: NewAccountBody }>("/admin/teachers", { schema: { body: newAccount } }, async (req, reply) => {
    if (!d.config.adminToken || req.headers.authorization !== `Bearer ${d.config.adminToken}`) {
      return reply.code(d.config.adminToken ? 401 : 403).send({ error: "admin token required" });
    }
    const a = await createAccount("teacher", req.body, reply);
    return a && reply.code(201).send({ account: accountView(a) });
  });

  app.post<{ Body: { login: string; password: string } }>("/auth/login", { schema: { body: credentials } }, async (req, reply) => {
    const a = await d.school.accountByLogin(normalizeLogin(req.body.login));
    const ok = await verifyPassword(req.body.password, a?.passwordHash ?? DUMMY_HASH);
    if (!a || !ok) return reply.code(401).send({ error: "credentials", message: "Неверный логин или пароль" });
    return signIn(a);
  });

  // ---------- Invitations
  app.get<{ Params: { code: string } }>("/invites/:code", async (req, reply) => {
    const g = await d.school.invite(req.params.code, now());
    if (!g) return reply.code(404).send({ error: "invite", message: "Приглашение не найдено или устарело" });
    return { group: { name: g.name, teacher_name: g.teacherName } };
  });

  /**
   * Joins the group. A signed-in student just joins; anyone else creates a student account.
   * A guest who has been playing on this phone keeps their progress: the account takes over
   * the guest's player id.
   */
  app.post<{ Params: { code: string }; Body: Partial<NewAccountBody> | undefined }>("/invites/:code/join", async (req, reply) => {
    const g = await d.school.invite(req.params.code, now());
    if (!g) return reply.code(404).send({ error: "invite", message: "Приглашение не найдено или устарело" });
    const session = await sessionOf(req);
    let account = session?.account ? await d.school.accountById(session.account.id) : undefined;
    if (account?.role === "teacher") return reply.code(409).send({ error: "teacher", message: "Преподаватель не может вступить в группу как ученик" });
    if (!account) {
      const body = req.body ?? {};
      const valid =
        typeof body.name === "string" && body.name.trim().length >= 1 && body.name.length <= 60 &&
        typeof body.login === "string" && typeof body.password === "string" && body.password.length >= 6 && body.password.length <= 128;
      if (!valid) return reply.code(400).send({ error: "fields", message: "Нужны имя, логин и пароль не короче 6 символов" });
      const guest = session && !session.account && !session.lti && !(await d.school.playerTaken(session.playerId)) ? session.playerId : undefined;
      account = await createAccount("student", body as NewAccountBody, reply, guest);
      if (!account) return;
    }
    await d.school.join(g.groupId, account.accountId);
    return reply.code(201).send({ ...(await signIn(account)), group: groupView(g) });
  });

  // ---------- What a student or a teacher sees
  app.get("/school/dashboard", { preHandler: requireAccount }, async (req) => {
    const a = req.account!;
    const groups = await d.school.groupsOf(a);
    const homework = await d.school.homeworkOf(groups.map((g) => g.groupId));
    const ids = homework.map((h) => h.homeworkId);
    if (a.role === "teacher") {
      const submissions = await d.school.submissionsFor(ids);
      return {
        account: accountView(a),
        groups: await Promise.all(groups.map(async (g) => ({ ...groupView(g), members: (await d.school.members(g.groupId)).map((m) => ({ id: m.accountId, name: m.name })) }))),
        homework: homework.map((h) => ({ ...homeworkView(h), submissions: submissions.filter((s) => s.homeworkId === h.homeworkId).map(submissionView) })),
      };
    }
    const mine = await d.school.submissionsFor(ids, a.accountId);
    return {
      account: accountView(a),
      groups: groups.map(groupView),
      homework: homework.map((h) => {
        const s = mine.find((x) => x.homeworkId === h.homeworkId);
        return { ...homeworkView(h), submission: s ? submissionView(s) : null };
      }),
    };
  });

  // ---------- Teacher: groups, invitations, homework
  app.post<{ Body: Required<Pick<GroupBody, "name">> & GroupBody }>(
    "/school/groups",
    { preHandler: requireTeacher, schema: { body: { type: "object", required: ["name"], additionalProperties: false, properties: groupFields } } },
    async (req, reply) => {
      const g = await d.school.createGroup({ teacherId: req.account!.accountId, name: req.body.name.trim(), callUrl: req.body.call_url ?? null, schedule: req.body.schedule ?? [] });
      return reply.code(201).send({ group: groupView(g) });
    },
  );

  app.patch<{ Params: { id: string }; Body: GroupBody }>(
    "/school/groups/:id",
    { preHandler: requireTeacher, schema: { body: { type: "object", additionalProperties: false, properties: groupFields } } },
    async (req, reply) => {
      if (!(await ownGroup(req, reply))) return;
      const g = await d.school.updateGroup(req.params.id, {
        ...(req.body.name !== undefined ? { name: req.body.name.trim() } : {}),
        ...(req.body.call_url !== undefined ? { callUrl: req.body.call_url } : {}),
        ...(req.body.schedule !== undefined ? { schedule: req.body.schedule } : {}),
      });
      return { group: groupView(g!) };
    },
  );

  app.post<{ Params: { id: string } }>("/school/groups/:id/invites", { preHandler: requireTeacher }, async (req, reply) => {
    if (!(await ownGroup(req, reply))) return;
    const invite = await d.school.createInvite(req.params.id, new Date(now().getTime() + INVITE_DAYS * 24 * 3600_000));
    const url = `${d.config.clientUrl.replace(/\/$/, "")}/join/${invite.code}`;
    return reply.code(201).send({ code: invite.code, url, expires_at: invite.expiresAt.toISOString() });
  });

  app.post<{ Params: { id: string }; Body: { title: string; description?: string; due_at?: string | null; needs_file: boolean } }>(
    "/school/groups/:id/homework",
    {
      preHandler: requireTeacher,
      schema: {
        body: {
          type: "object",
          required: ["title", "needs_file"],
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 120 },
            description: { type: "string", maxLength: 4000 },
            due_at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
            needs_file: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      if (!(await ownGroup(req, reply))) return;
      const h = await d.school.createHomework({
        groupId: req.params.id,
        title: req.body.title.trim(),
        description: (req.body.description ?? "").trim(),
        dueAt: req.body.due_at ? new Date(req.body.due_at) : null,
        needsFile: req.body.needs_file,
      });
      return reply.code(201).send({ homework: homeworkView(h) });
    },
  );

  // ---------- Hand-in files
  // The body is the file itself (no multipart): a phone streams it straight from the picker,
  // and the server streams it to storage without holding 50 MB in memory.
  await app.register(async (files) => {
    files.removeAllContentTypeParsers();
    files.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

    files.put<{ Params: { id: string }; Querystring: { name?: string } }>("/school/homework/:id/submission", { preHandler: requireAccount }, async (req, reply) => {
      const body = req.body as Readable | undefined;
      const drain = () => body?.resume();
      const h = await d.school.homework(req.params.id);
      if (!h || !(await d.school.isMember(h.groupId, req.account!.accountId))) return (drain(), reply.code(404).send({ error: "no such homework" }));
      if (!h.needsFile) return (drain(), reply.code(409).send({ error: "no_file", message: "Эта домашка сдаётся без файла" }));
      const fileName = basename(String(req.query.name ?? "file")).replace(/[\u0000-\u001f\u007f/\\]/g, "").slice(-120) || "file";
      const mime = acceptedType(req.headers["content-type"], fileName);
      if (!mime) return (drain(), reply.code(415).send({ error: "type", message: "Такой файл не принимается: нужна запись, фото, видео, PDF или документ Word" }));
      if (Number(req.headers["content-length"] ?? 0) > MAX_UPLOAD_BYTES) return (drain(), reply.code(413).send({ error: "size", message: "Файл больше 50 МБ" }));
      if (!body) return reply.code(400).send({ error: "empty", message: "Файл пустой" });

      const key = `homework/${h.homeworkId}/${req.account!.accountId}/${crypto.randomUUID()}${extname(fileName).toLowerCase().slice(0, 8)}`;
      let size: number;
      try {
        size = await d.files.put(key, body, MAX_UPLOAD_BYTES);
      } catch (e) {
        if (e instanceof FileTooLargeError) return reply.code(413).send({ error: "size", message: "Файл больше 50 МБ" });
        throw e;
      }
      if (size === 0) {
        await d.files.delete(key);
        return reply.code(400).send({ error: "empty", message: "Файл пустой" });
      }
      const { submission, replacedKey } = await d.school.submit({ homeworkId: h.homeworkId, accountId: req.account!.accountId, fileKey: key, fileName, mime, size });
      if (replacedKey) await d.files.delete(replacedKey).catch((e) => req.log.warn({ err: e }, "old hand-in file not deleted"));
      return reply.code(201).send({ submission: submissionView(submission) });
    });
  });

  /** The submission, if this account may open it: the student who sent it or the group's teacher. */
  const visibleSubmission = async (submissionId: string, a: Account): Promise<Submission | undefined> => {
    const s = await d.school.submission(submissionId);
    const h = s && (await d.school.homework(s.homeworkId));
    const g = h && (await d.school.group(h.groupId));
    return s && g && (s.accountId === a.accountId || g.teacherId === a.accountId) ? s : undefined;
  };
  const linkKey = new TextEncoder().encode(`file-link:${d.config.sessionSecret}`);

  /**
   * A short-lived link to the file. The browser opens it like any download, so the file
   * keeps its name and opens on phones too, where saving a blob from script is unreliable.
   */
  app.post<{ Params: { id: string } }>("/school/submissions/:id/link", { preHandler: requireAccount }, async (req, reply) => {
    if (!(await visibleSubmission(req.params.id, req.account!))) return reply.code(404).send({ error: "not found" });
    const t = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(req.params.id).setIssuedAt().setExpirationTime(`${FILE_LINK_SECONDS}s`).sign(linkKey);
    return { url: `/school/submissions/${req.params.id}/file?t=${t}` };
  });

  /** The handed-in file: with the account's session, or with a link from the endpoint above. */
  app.get<{ Params: { id: string }; Querystring: { t?: string } }>("/school/submissions/:id/file", async (req, reply) => {
    let s: Submission | undefined;
    if (req.query.t) {
      const claims = await jwtVerify(req.query.t, linkKey, { algorithms: ["HS256"] }).catch(() => undefined);
      if (claims?.payload.sub === req.params.id) s = await d.school.submission(req.params.id);
    } else {
      await requireAccount(req, reply);
      if (reply.sent) return;
      s = await visibleSubmission(req.params.id, req.account!);
    }
    if (!s) return reply.code(404).send({ error: "not found" });
    const file = await d.files.open(s.fileKey);
    if (!file) return reply.code(404).send({ error: "file missing" });
    return reply
      .type(s.mime)
      .header("Content-Length", file.size)
      .header("Content-Disposition", `attachment; filename="${s.fileName.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(s.fileName)}`)
      .header("Cache-Control", "private, no-store")
      .send(file.stream);
  });
}
