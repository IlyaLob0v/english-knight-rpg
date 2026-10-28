import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { validateContent, type ContentSource } from "@moonbridge/content";
import { buildBundle, loadContentDir } from "@moonbridge/content/node";
import { readXlsx, writeXlsx, SHEETS, type Workbook } from "@moonbridge/content/sheet";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LiveContent } from "../src/content/live.js";
import { ContentVersions } from "../src/content/versions.js";
import { migrate, type Sql } from "../src/db/sql.js";
import { DiskFileStore } from "../src/school/files.js";
import { FailureLimiter } from "../src/school/limits.js";
import { S3FileStore, signV4 } from "../src/school/s3.js";
import { SchoolStore } from "../src/school/store.js";
import { CONTENT_DIR, harness } from "./harness.js";

let pglite: PGlite;
let sql: Sql;
let uploads: string;
let source: ContentSource;
let clock = new Date("2026-12-14T09:00:00Z");

beforeAll(async () => {
  pglite = new PGlite();
  sql = { query: (text, params) => pglite.query(text, params), exec: (text) => pglite.exec(text) } as Sql;
  await migrate(sql);
  uploads = await mkdtemp(join(tmpdir(), "moonbridge-uploads-"));
  source = (await loadContentDir(CONTENT_DIR)).source;
});

afterAll(async () => {
  await pglite.close();
  await rm(uploads, { recursive: true, force: true });
});

beforeEach(async () => {
  clock = new Date("2026-12-14T09:00:00Z");
  await sql.exec("TRUNCATE accounts, school_groups, group_members, invites, homework, submissions, attempts, content_versions CASCADE");
});

/** The gateway as it starts: the repository's content, with whatever was published before laid over it. */
async function gateway(fetchSheet?: typeof fetch) {
  const content = new LiveContent(buildBundle(validateContent(source).content!), source, new ContentVersions(sql));
  await content.restore();
  const h = await harness({ school: { store: new SchoolStore(sql), files: new DiskFileStore(uploads), now: () => clock }, content, ...(fetchSheet ? { fetchSheet } : {}) });
  return h.app;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function signIn(app: FastifyInstance, login: string, password: string) {
  return app.inject({ method: "POST", url: "/auth/login", payload: { login, password } });
}

async function teacher(app: FastifyInstance): Promise<string> {
  await app.inject({ method: "POST", url: "/admin/teachers", headers: auth("admin-secret"), payload: { name: "Ксения", login: "ksenia", password: "teach-123" } });
  return (await signIn(app, "ksenia", "teach-123")).json().token;
}

async function student(app: FastifyInstance, teacherToken: string): Promise<string> {
  const g = await app.inject({ method: "POST", url: "/school/groups", headers: auth(teacherToken), payload: { name: "A1" } });
  const inv = await app.inject({ method: "POST", url: `/school/groups/${g.json().group.group_id}/invites`, headers: auth(teacherToken) });
  const joined = await app.inject({ method: "POST", url: `/invites/${inv.json().code}/join`, payload: { name: "Анна", login: "anna", password: "secret-1" } });
  return joined.json().token;
}

async function downloadSheet(app: FastifyInstance, token: string): Promise<Workbook> {
  const res = await app.inject({ method: "GET", url: "/school/content/sheet", headers: auth(token) });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("spreadsheetml");
  return readXlsx(res.rawPayload);
}

function setCell(book: Workbook, sheet: string, match: (row: string[], header: string[]) => boolean, col: string, value: string) {
  const [header, ...rows] = book[sheet]!;
  const row = rows.find((r) => match(r, header!))!;
  row[header!.indexOf(col)] = value;
}

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const post = (app: FastifyInstance, token: string, what: "check" | "publish", book: Workbook, name = "контент.xlsx") =>
  app.inject({ method: "POST", url: `/school/content/${what}?name=${encodeURIComponent(name)}`, headers: { ...auth(token), "content-type": XLSX }, payload: Buffer.from(writeXlsx(book)) });

describe("content from the teacher's sheet", () => {
  it("lets the teacher download the course, change a task, check and publish it; students get it, and it survives a restart", async () => {
    const app = await gateway();
    const token = await teacher(app);
    const before = (await app.inject({ method: "GET", url: "/content/manifest" })).json().content_hash;

    const book = await downloadSheet(app, token);
    setCell(book, SHEETS.tasks, (r, h) => r[h.indexOf("задание")] === "q1" && r[h.indexOf("юнит")] === "A1_VerbToBe_01", "текст задания", "I ___ the new night porter.");

    const check = await post(app, token, "check", book);
    expect(check.statusCode).toBe(200);
    expect(check.json()).toMatchObject({ ok: true, summary: { changed: ["A1_VerbToBe_01"], added: [], removed: [] } });
    // Checking changes nothing.
    expect((await app.inject({ method: "GET", url: "/content/manifest" })).json().content_hash).toBe(before);

    const published = await post(app, token, "publish", book);
    expect(published.statusCode).toBe(200);
    expect(published.json().content).toMatchObject({ published: { by: "Ксения", source: "контент.xlsx" } });
    const bundle = (await app.inject({ method: "GET", url: "/content/bundle" })).json();
    expect(bundle.content_hash).not.toBe(before);
    expect(bundle.tasks.A1_VerbToBe_01_q1.presentation.prompt).toBe("I ___ the new night porter.");
    expect(bundle.modules.find((m: { module_id: string }) => m.module_id === "A1_VerbToBe_01").version).toBe(3);
    await app.close();

    const again = await gateway();
    const after = (await again.inject({ method: "GET", url: "/content/bundle" })).json();
    expect(after.content_hash).toBe(bundle.content_hash);
    const state = await again.inject({ method: "GET", url: "/school/content", headers: auth((await signIn(again, "ksenia", "teach-123")).json().token) });
    expect(state.json()).toMatchObject({ content_hash: bundle.content_hash, editable: true, published: { by: "Ксения" } });
  });

  it("refuses a sheet with errors and keeps the live content", async () => {
    const app = await gateway();
    const token = await teacher(app);
    const before = (await app.inject({ method: "GET", url: "/content/manifest" })).json().content_hash;
    const book = await downloadSheet(app, token);
    setCell(book, SHEETS.tasks, (r, h) => r[h.indexOf("задание")] === "q1", "тип", "выборр");
    const res = await post(app, token, "publish", book);
    expect(res.statusCode).toBe(422);
    expect(res.json().issues).toEqual([expect.objectContaining({ severity: "error", where: `${SHEETS.tasks}, строка 2`, message: expect.stringContaining("тип «выборр» не знаком") })]);
    expect((await app.inject({ method: "GET", url: "/content/manifest" })).json().content_hash).toBe(before);

    const junk = await app.inject({ method: "POST", url: "/school/content/check", headers: { ...auth(token), "content-type": XLSX }, payload: Buffer.from("not a workbook") });
    expect(junk.statusCode).toBe(422);
    expect(junk.json().message).toBe("это не файл Excel (.xlsx)");
  });

  it("reads a Google Sheet by its link, and says so when the sheet is closed", async () => {
    let xlsx: Uint8Array | undefined;
    const requested: string[] = [];
    const fakeGoogle = (async (url: string) => {
      requested.push(url);
      return xlsx ? new Response(Buffer.from(xlsx), { headers: { "content-type": XLSX } }) : new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const app = await gateway(fakeGoogle);
    const token = await teacher(app);
    const link = "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0";

    const closed = await app.inject({ method: "POST", url: "/school/content/check", headers: auth(token), payload: { url: link } });
    expect(closed.statusCode).toBe(422);
    expect(closed.json().message).toMatch(/^Таблица закрыта/);
    expect(requested).toEqual(["https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/export?format=xlsx"]);

    xlsx = writeXlsx(await downloadSheet(app, token));
    const open = await app.inject({ method: "POST", url: "/school/content/publish", headers: auth(token), payload: { url: link } });
    expect(open.statusCode).toBe(200);
    expect(open.json().content.published.source).toBe(link);

    const notGoogle = await app.inject({ method: "POST", url: "/school/content/check", headers: auth(token), payload: { url: "https://example.com/sheet.xlsx" } });
    expect(notGoogle.statusCode).toBe(422);
    expect(requested).toHaveLength(2);
  });

  it("is for teachers only", async () => {
    const app = await gateway();
    const token = await teacher(app);
    const studentToken = await student(app, token);
    for (const [method, url] of [["GET", "/school/content"], ["GET", "/school/content/sheet"], ["POST", "/school/content/check"], ["POST", "/school/content/publish"]] as const) {
      expect((await app.inject({ method, url, headers: auth(studentToken), payload: { url: "x" } })).statusCode).toBe(403);
      expect((await app.inject({ method, url, payload: { url: "x" } })).statusCode).toBe(401);
    }
  });
});

describe("password guessing", () => {
  it("pauses a login after 5 wrong passwords for 15 minutes, and an address after 30", async () => {
    const app = await gateway();
    await teacher(app);
    for (let i = 0; i < 5; i++) expect((await signIn(app, "ksenia", "wrong")).statusCode).toBe(401);
    const locked = await signIn(app, "ksenia", "teach-123");
    expect(locked.statusCode).toBe(429);
    expect(locked.json().message).toBe("Слишком много неудачных попыток. Попробуйте через 15 мин.");
    expect(locked.headers["retry-after"]).toBe("900");
    clock = new Date(clock.getTime() + 15 * 60_000 + 1000);
    expect((await signIn(app, "ksenia", "teach-123")).statusCode).toBe(200);

    // Spraying many logins from one address hits the address limit.
    for (let i = 0; i < 30; i++) await signIn(app, `nobody${i}`, "wrong");
    expect((await signIn(app, "ksenia", "teach-123")).statusCode).toBe(429);
  });

  it("forgets the failures of a login once its password is right", () => {
    let now = 0;
    const limiter = new FailureLimiter(3, 60_000, () => now);
    limiter.fail("a");
    limiter.fail("a");
    limiter.reset("a");
    limiter.fail("a");
    limiter.fail("a");
    expect(limiter.retryAfter("a")).toBe(0);
    limiter.fail("a");
    expect(limiter.retryAfter("a")).toBe(60);
    now = 30_000;
    expect(limiter.retryAfter("a")).toBe(30);
  });
});

describe("homework files in an S3 bucket", () => {
  it("signs requests the way AWS documents it (Signature V4, GET Object example)", () => {
    const headers = signV4({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      headers: { range: "bytes=0-9" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      date: new Date("2013-05-24T00:00:00Z"),
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("puts, opens and deletes a file, and refuses one over the limit before it reaches the bucket", async () => {
    const objects = new Map<string, Buffer>();
    const seen: { method: string; url: string; auth: string; sha: string }[] = [];
    const server: Server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      seen.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization), sha: String(req.headers["x-amz-content-sha256"]) });
      if (req.method === "PUT") objects.set(req.url!, Buffer.concat(chunks));
      if (req.method === "DELETE") objects.delete(req.url!);
      if (req.method === "GET") {
        const body = objects.get(req.url!);
        if (!body) return res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
        return res.writeHead(200, { "content-length": body.length }).end(body);
      }
      res.writeHead(req.method === "DELETE" ? 204 : 200).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const store = new S3FileStore({ endpoint: `http://127.0.0.1:${port}`, region: "ru-central1", bucket: "moonbridge-files", accessKeyId: "key", secretAccessKey: "secret" });
      const body = Buffer.from("voice memo bytes");
      expect(await store.put("homework/hw_1/acc_1/a b.m4a", Readable.from([body]), 1000)).toBe(body.length);
      expect(seen[0]).toMatchObject({ method: "PUT", url: "/moonbridge-files/homework/hw_1/acc_1/a%20b.m4a", sha: createHash("sha256").update(body).digest("hex") });
      expect(seen[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=key\/\d{8}\/ru-central1\/s3\/aws4_request, SignedHeaders=content-length;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);

      const opened = await store.open("homework/hw_1/acc_1/a b.m4a");
      expect(opened!.size).toBe(body.length);
      const chunks: Buffer[] = [];
      for await (const c of opened!.stream) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks)).toEqual(body);

      await store.delete("homework/hw_1/acc_1/a b.m4a");
      expect(await store.open("homework/hw_1/acc_1/a b.m4a")).toBeUndefined();

      const requests = seen.length;
      await expect(store.put("homework/big", Readable.from([Buffer.alloc(2000)]), 1000)).rejects.toThrow("larger than 1000 bytes");
      expect(seen.length).toBe(requests);
    } finally {
      server.close();
    }
  });
});
