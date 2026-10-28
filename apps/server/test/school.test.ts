import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, type Sql } from "../src/db/sql.js";
import { DiskFileStore } from "../src/school/files.js";
import { acceptedType, MAX_UPLOAD_BYTES } from "../src/school/routes.js";
import { SchoolStore } from "../src/school/store.js";
import { harness } from "./harness.js";

let pglite: PGlite;
let sql: Sql;
let uploads: string;
let clock = new Date("2026-11-30T09:00:00Z");

beforeAll(async () => {
  pglite = new PGlite();
  sql = { query: (text, params) => pglite.query(text, params), exec: (text) => pglite.exec(text) } as Sql;
  await migrate(sql);
  uploads = await mkdtemp(join(tmpdir(), "moonbridge-uploads-"));
});

afterAll(async () => {
  await pglite.close();
  await rm(uploads, { recursive: true, force: true });
});

beforeEach(async () => {
  clock = new Date("2026-11-30T09:00:00Z");
  await sql.exec("TRUNCATE accounts, school_groups, group_members, invites, homework, submissions, player_progress CASCADE");
});

async function school() {
  const h = await harness({ school: { store: new SchoolStore(sql), files: new DiskFileStore(uploads), now: () => clock } });
  return h.app;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function teacher(app: FastifyInstance): Promise<string> {
  const created = await app.inject({ method: "POST", url: "/admin/teachers", headers: auth("admin-secret"), payload: { name: "Ксения", login: "Ksenia@School.ru", password: "teach-123" } });
  expect(created.statusCode).toBe(201);
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { login: "ksenia@school.ru", password: "teach-123" } });
  expect(res.statusCode).toBe(200);
  return res.json().token;
}

async function groupWithInvite(app: FastifyInstance, token: string) {
  const g = await app.inject({
    method: "POST",
    url: "/school/groups",
    headers: auth(token),
    payload: { name: "A1 вечер", call_url: "https://telemost.yandex.ru/j/123", schedule: [{ weekday: 2, time: "18:30", minutes: 60 }, { weekday: 4, time: "18:30", minutes: 60 }] },
  });
  expect(g.statusCode).toBe(201);
  const groupId = g.json().group.group_id as string;
  const inv = await app.inject({ method: "POST", url: `/school/groups/${groupId}/invites`, headers: auth(token) });
  expect(inv.statusCode).toBe(201);
  return { groupId, code: inv.json().code as string, url: inv.json().url as string };
}

async function joinGroup(app: FastifyInstance, code: string, login = "anna", headers: Record<string, string> = {}) {
  return app.inject({ method: "POST", url: `/invites/${code}/join`, headers, payload: { name: "Анна", login, password: "secret-1" } });
}

async function homework(app: FastifyInstance, token: string, groupId: string, needsFile = true) {
  const res = await app.inject({
    method: "POST",
    url: `/school/groups/${groupId}/homework`,
    headers: auth(token),
    payload: { title: "Расскажи о себе", description: "Запиши 30 секунд на диктофон.", due_at: "2026-12-03T15:00:00.000Z", needs_file: needsFile },
  });
  expect(res.statusCode).toBe(201);
  return res.json().homework.homework_id as string;
}

function upload(app: FastifyInstance, token: string, homeworkId: string, body: Buffer, type = "audio/mp4", name = "Запись 1.m4a") {
  return app.inject({
    method: "PUT",
    url: `/school/homework/${homeworkId}/submission?name=${encodeURIComponent(name)}`,
    headers: { ...auth(token), "content-type": type },
    payload: body,
  });
}

describe("accounts", () => {
  it("creates teachers only with the admin token and signs them in with a login in any case", async () => {
    const app = await school();
    const anon = await app.inject({ method: "POST", url: "/admin/teachers", payload: { name: "X", login: "x-teacher", password: "teach-123" } });
    expect(anon.statusCode).toBe(401);
    await teacher(app);
    const wrong = await app.inject({ method: "POST", url: "/auth/login", payload: { login: "ksenia@school.ru", password: "nope-nope" } });
    expect(wrong.statusCode).toBe(401);
    const unknown = await app.inject({ method: "POST", url: "/auth/login", payload: { login: "nobody", password: "nope-nope" } });
    expect(unknown.json().message).toBe(wrong.json().message);
  });

  it("tells the client whether guests may play", async () => {
    const app = await school();
    expect((await app.inject({ url: "/auth/options" })).json()).toEqual({ guest: true });
  });
});

describe("groups and invitations", () => {
  it("lets a student join by the link, then see the group, its schedule and its homework", async () => {
    const app = await school();
    const t = await teacher(app);
    const { groupId, code, url } = await groupWithInvite(app, t);
    expect(url).toBe(`https://app.moonbridge.test/join/${code}`);
    expect((await app.inject({ url: `/invites/${code}` })).json()).toEqual({ group: { name: "A1 вечер", teacher_name: "Ксения" } });

    const joined = await joinGroup(app, code);
    expect(joined.statusCode).toBe(201);
    const s = joined.json().token as string;
    expect(joined.json().account).toMatchObject({ name: "Анна", role: "student", login: "anna" });
    const hw = await homework(app, t, groupId);

    const dash = (await app.inject({ url: "/school/dashboard", headers: auth(s) })).json();
    expect(dash.groups).toEqual([
      { group_id: groupId, name: "A1 вечер", teacher_name: "Ксения", call_url: "https://telemost.yandex.ru/j/123", schedule: [{ weekday: 2, time: "18:30", minutes: 60 }, { weekday: 4, time: "18:30", minutes: 60 }] },
    ]);
    expect(dash.homework).toMatchObject([{ homework_id: hw, title: "Расскажи о себе", needs_file: true, due_at: "2026-12-03T15:00:00.000Z", submission: null }]);

    const teacherView = (await app.inject({ url: "/school/dashboard", headers: auth(t) })).json();
    expect(teacherView.groups[0].members).toEqual([{ id: joined.json().account.id, name: "Анна" }]);
    expect(teacherView.homework[0].submissions).toEqual([]);
  });

  it("refuses an expired invitation, a taken login and a second teacher's group", async () => {
    const app = await school();
    const t = await teacher(app);
    const { groupId, code } = await groupWithInvite(app, t);
    expect((await joinGroup(app, code)).statusCode).toBe(201);
    expect((await joinGroup(app, code)).statusCode).toBe(409);

    await app.inject({ method: "POST", url: "/admin/teachers", headers: auth("admin-secret"), payload: { name: "Другой", login: "other", password: "teach-123" } });
    const other = (await app.inject({ method: "POST", url: "/auth/login", payload: { login: "other", password: "teach-123" } })).json().token;
    expect((await app.inject({ method: "POST", url: `/school/groups/${groupId}/invites`, headers: auth(other) })).statusCode).toBe(404);

    clock = new Date(clock.getTime() + 15 * 24 * 3600_000);
    expect((await app.inject({ url: `/invites/${code}` })).statusCode).toBe(404);
    expect((await joinGroup(app, code, "late")).statusCode).toBe(404);
  });

  it("keeps a guest's progress when the guest joins with an account", async () => {
    const app = await school();
    const t = await teacher(app);
    const { code } = await groupWithInvite(app, t);
    const guest = (await app.inject({ method: "POST", url: "/session/guest" })).json();
    await app.inject({ method: "PUT", url: "/progress/snapshot", headers: auth(guest.token), payload: { saved_at: new Date().toISOString(), snapshot: { moonbridge: { completed_episodes: ["e1"] } } } });

    const joined = await joinGroup(app, code, "anna", auth(guest.token));
    expect(joined.json().player_id).toBe(guest.player_id);

    // On a new phone: sign in, and the hotel is there.
    const again = (await app.inject({ method: "POST", url: "/auth/login", payload: { login: "anna", password: "secret-1" } })).json();
    expect(again.player_id).toBe(guest.player_id);
    const snap = await app.inject({ url: "/progress/snapshot", headers: auth(again.token) });
    expect(snap.json().snapshot).toEqual({ moonbridge: { completed_episodes: ["e1"] } });
  });

  it("adds a signed-in student to a second group without a new account", async () => {
    const app = await school();
    const t = await teacher(app);
    const first = await groupWithInvite(app, t);
    const second = await groupWithInvite(app, t);
    const s = (await joinGroup(app, first.code)).json();
    const res = await app.inject({ method: "POST", url: `/invites/${second.code}/join`, headers: auth(s.token) });
    expect(res.statusCode).toBe(201);
    expect(res.json().account.id).toBe(s.account.id);
    const dash = (await app.inject({ url: "/school/dashboard", headers: auth(s.token) })).json();
    expect(dash.groups.map((g: { group_id: string }) => g.group_id)).toEqual([first.groupId, second.groupId]);
  });

  it("keeps teacher endpoints for teachers", async () => {
    const app = await school();
    const t = await teacher(app);
    const { groupId, code } = await groupWithInvite(app, t);
    const s = (await joinGroup(app, code)).json().token;
    expect((await app.inject({ method: "POST", url: "/school/groups", headers: auth(s), payload: { name: "Моя" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/school/groups/${groupId}/homework`, headers: auth(s), payload: { title: "x", needs_file: false } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/school/dashboard" })).statusCode).toBe(401);
    const patched = await app.inject({ method: "PATCH", url: `/school/groups/${groupId}`, headers: auth(t), payload: { call_url: null } });
    expect(patched.json().group.call_url).toBeNull();
    expect(patched.json().group.schedule).toHaveLength(2);
  });
});

describe("hand-in files", () => {
  it("takes a voice memo from the phone, shows it to the student and lets the teacher download it", async () => {
    const app = await school();
    const t = await teacher(app);
    const { groupId, code } = await groupWithInvite(app, t);
    const s = (await joinGroup(app, code)).json().token;
    const hw = await homework(app, t, groupId);

    const audio = Buffer.alloc(300_000, 7);
    const res = await upload(app, s, hw, audio);
    expect(res.statusCode).toBe(201);
    expect(res.json().submission).toMatchObject({ file_name: "Запись 1.m4a", mime: "audio/mp4", size: 300_000, student_name: "Анна" });

    const mine = (await app.inject({ url: "/school/dashboard", headers: auth(s) })).json().homework[0].submission;
    expect(mine.submission_id).toBe(res.json().submission.submission_id);
    const seen = (await app.inject({ url: "/school/dashboard", headers: auth(t) })).json().homework[0].submissions;
    expect(seen).toHaveLength(1);

    const file = await app.inject({ url: `/school/submissions/${mine.submission_id}/file`, headers: auth(t) });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("audio/mp4");
    expect(file.headers["content-disposition"]).toBe(`attachment; filename="______ 1.m4a"; filename*=UTF-8''${encodeURIComponent("Запись 1.m4a")}`);
    expect(file.rawPayload.equals(audio)).toBe(true);

    // A link the browser can open on its own, without the session header.
    const link = (await app.inject({ method: "POST", url: `/school/submissions/${mine.submission_id}/link`, headers: auth(t) })).json().url as string;
    const viaLink = await app.inject({ url: link });
    expect(viaLink.statusCode).toBe(200);
    expect(viaLink.rawPayload.equals(audio)).toBe(true);
    expect((await app.inject({ url: link.replace(mine.submission_id, "sub_other") })).statusCode).toBe(404);
    expect((await app.inject({ url: `${link}x` })).statusCode).toBe(404);
  });

  it("replaces the file on a second upload and deletes the old one", async () => {
    const app = await school();
    const t = await teacher(app);
    const { groupId, code } = await groupWithInvite(app, t);
    const s = (await joinGroup(app, code)).json().token;
    const hw = await homework(app, t, groupId);
    await upload(app, s, hw, Buffer.from("first"), "image/jpeg", "page.jpg");
    const second = await upload(app, s, hw, Buffer.from("second photo"), "image/jpeg", "page2.jpg");
    expect(second.json().submission).toMatchObject({ file_name: "page2.jpg", size: 12 });
    const dir = join(uploads, "homework", hw);
    const [student] = await readdir(dir);
    expect(await readdir(join(dir, student!))).toHaveLength(1);
  });

  it("refuses files over 50 MB, foreign types, strangers and homework without a file", async () => {
    const app = await school();
    const t = await teacher(app);
    const { groupId, code } = await groupWithInvite(app, t);
    const s = (await joinGroup(app, code)).json().token;
    const hw = await homework(app, t, groupId);

    const big = await upload(app, s, hw, Buffer.alloc(MAX_UPLOAD_BYTES + 1));
    expect(big.statusCode).toBe(413);
    expect((await upload(app, s, hw, Buffer.from("MZ"), "application/x-msdownload", "game.exe")).statusCode).toBe(415);

    const other = await groupWithInvite(app, t);
    const stranger = (await joinGroup(app, other.code, "boris")).json().token;
    expect((await upload(app, stranger, hw, Buffer.from("x"))).statusCode).toBe(404);

    const plain = await homework(app, t, groupId, false);
    expect((await upload(app, s, plain, Buffer.from("x"))).statusCode).toBe(409);

    const ok = await upload(app, s, hw, Buffer.from("x"));
    const id = ok.json().submission.submission_id;
    expect((await app.inject({ url: `/school/submissions/${id}/file`, headers: auth(stranger) })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/school/submissions/${id}/link`, headers: auth(stranger) })).statusCode).toBe(404);
  });

  it("knows a file by its extension when the phone does not say its type", () => {
    expect(acceptedType("application/octet-stream", "voice.M4A")).toBe("audio/mp4");
    expect(acceptedType("", "IMG_0001.HEIC")).toBe("image/heic");
    expect(acceptedType("audio/x-m4a", "x")).toBe("audio/x-m4a");
    expect(acceptedType("application/pdf", "essay")).toBe("application/pdf");
    expect(acceptedType("application/zip", "homework.zip")).toBeUndefined();
  });
});
