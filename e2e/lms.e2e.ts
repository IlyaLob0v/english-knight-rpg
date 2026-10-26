// End-to-end check of the LMS integration against the local stack (compose.yaml):
//
//   Moodle course → LTI 1.3 launch → the game in Moodle's iframe → three battles,
//   two of them offline → the module boss → the grade in the Moodle gradebook (AGS)
//   and every answer in the LRS exactly once (xAPI), the week's errors on a concept
//   from the LRS, and the city restored on a second device.
//
// Needs: pnpm lms:up, pnpm dev:server:lms and pnpm dev:client running.
// Run:   pnpm e2e:lms          (HEADED=1 to watch it)
import { execFileSync } from "node:child_process";
import type { ContentBundle, Task } from "@knight/content";
import { conceptErrors, KnightProfile, LrsClient, type Statement } from "@knight/xapi";
import { chromium, type BrowserContext, type Frame, type Page } from "playwright";

const MOODLE = "http://localhost:8080";
const GATEWAY = process.env.PUBLIC_URL ?? "http://localhost:8787";
const CLIENT = process.env.CLIENT_URL ?? "http://localhost:5173";
const PASSWORD = "Knight-E2e-1";
const GAME_W = 960;
const GAME_H = 600;
/** The acceptance bar: a boss victory reaches the gradebook within a minute. */
const GRADE_DEADLINE_MS = 60_000;

const started = new Date();
const student = `e2e_${Date.now().toString(36)}`;
const profile = new KnightProfile(process.env.XAPI_BASE_IRI ?? "https://knight.example.com");
const lrs = new LrsClient({
  endpoint: process.env.LRS_ENDPOINT ?? "http://localhost:8090/xapi",
  key: process.env.LRS_KEY ?? "knight-gateway",
  secret: process.env.LRS_SECRET ?? "knight-gateway-secret",
});

function step(message: string): void {
  console.log(`\n▶ ${message}`);
}

function check(ok: unknown, message: string): void {
  if (!ok) throw new Error(`FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function poll<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** SQL against a database of the stack, through the postgres container (no psql needed on the host). */
function psql(db: string, query: string): string {
  return execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", db, "-tAc", query], { encoding: "utf8" }).trim();
}

// ---------- Moodle

async function moodleLogin(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${MOODLE}/login/index.php`);
  await page.fill("#username", student);
  await page.fill("#password", PASSWORD);
  await page.click("#loginbtn");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  return page;
}

async function openActivity(page: Page, moduleTitle: string): Promise<Frame> {
  await page.goto(`${MOODLE}/course/view.php?name=KNIGHT`);
  await page.getByRole("link", { name: new RegExp(`Knight of Words: ${moduleTitle}`) }).first().click();
  return poll("the game inside Moodle's iframe", 30_000, async () => {
    const frame = page.frames().find((f) => f.url().startsWith(CLIENT));
    if (!frame) return undefined;
    const ready = await frame.evaluate(() => Boolean(localStorage.getItem("knight.session")) && document.querySelector("#game canvas, .story") !== null);
    return ready ? frame : undefined;
  });
}

// ---------- The game

interface Played {
  answers: number;
  wrong: { taskId: string; conceptId: string; response: string; errorType: string }[];
}

/** Finds the bundle task on screen by its prompt, source text and the word or option buttons. */
function taskOnScreen(bundle: ContentBundle, prompt: string, source: string | null, buttons: string[]): Task {
  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
  const found = Object.values(bundle.tasks).filter(
    (t) =>
      t.presentation.prompt === prompt &&
      (t.presentation.source ?? null) === source &&
      same(buttons, t.presentation.tokens ?? t.presentation.options?.map((o) => o.text) ?? []),
  );
  if (found.length !== 1) throw new Error(`cannot tell which task is shown: "${prompt}" (${found.length} matches)`);
  return found[0]!;
}

/** Answers the task on screen, wrongly with an author-tagged error when asked to and when the task has one. */
async function answer(frame: Frame, task: Task, wrong: boolean, played: Played): Promise<void> {
  const tagged = task.type !== "order_words" ? task.answer.known_errors?.[0] : undefined;
  const value = wrong && tagged ? tagged.match[0]! : task.answer.accepted[0]!;
  played.answers++;
  if (wrong && tagged) played.wrong.push({ taskId: task.task_id, conceptId: task.concept_id, response: value, errorType: tagged.error_type });

  if (task.type === "choice") {
    const text = task.presentation.options!.find((o) => o.id === value)!.text;
    await frame.locator(".task .option", { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).first().click();
  } else if (task.type === "order_words") {
    // Click the bank tokens in the order of the accepted sentence.
    let rest = value;
    const tokens = [...task.presentation.tokens!];
    while (rest.trim()) {
      rest = rest.trimStart();
      const i = tokens.findIndex((t) => rest.startsWith(t));
      if (i < 0) throw new Error(`cannot build "${value}" from ${task.presentation.tokens!.join(" ")}`);
      await frame.locator(".order-bank .token", { hasText: tokens[i]! }).first().click();
      rest = rest.slice(tokens[i]!.length);
      tokens.splice(i, 1);
    }
    await frame.locator(".task button.primary").click();
  } else {
    await frame.fill(".task input.answer", value);
    await frame.press(".task input.answer", "Enter");
  }
}

/** Plays tasks until the battle's end menu shows; one wrong answer per battle when `wrongOnce`. */
async function fight(frame: Frame, bundle: ContentBundle, played: Played, wrongOnce: boolean): Promise<string> {
  let wrongLeft = wrongOnce;
  for (;;) {
    const state = await poll("the next battle screen", 20_000, async () => {
      if (await frame.locator(".task:not([data-e2e])").count()) return "task";
      if (await frame.locator(".feedback button.primary").count()) return "feedback";
      if (await frame.locator(".menu .menu-title").count()) return "menu";
      return undefined;
    });
    if (state === "menu") return (await frame.locator(".menu .menu-title").textContent()) ?? "";
    if (state === "feedback") {
      await frame.locator(".feedback button.primary").click();
      continue;
    }
    const panel = frame.locator(".task:not([data-e2e])").first();
    const prompt = (await panel.locator(".task-prompt").textContent())!;
    const source = (await panel.locator(".task-source").count()) ? await panel.locator(".task-source").textContent() : null;
    const buttons = await panel.locator(".order-bank .token, .option").allTextContents();
    const task = taskOnScreen(bundle, prompt, source, buttons);
    const wrong = wrongLeft && task.type !== "order_words" && Boolean(task.answer.known_errors?.length);
    if (wrong) wrongLeft = false;
    await panel.evaluate((el) => el.setAttribute("data-e2e", "done"));
    await answer(frame, task, wrong, played);
  }
}

async function clickMenu(frame: Frame, label: string | RegExp): Promise<void> {
  await frame.locator(".menu button", { hasText: label }).first().click();
}

/** Plays through story dialogs until none is left. */
async function skipStories(frame: Frame): Promise<void> {
  for (let i = 0; i < 50 && (await frame.locator(".story button.primary").count()); i++) {
    await frame.locator(".story button.primary").click();
    await frame.waitForTimeout(50);
  }
}

/** Clicks a point of the Phaser canvas given in game coordinates (960×600, scaled to fit). */
async function clickCanvas(page: Page, frame: Frame, x: number, y: number): Promise<void> {
  const box = (await frame.locator("#game canvas").boundingBox())!;
  const scale = Math.min(box.width / GAME_W, box.height / GAME_H);
  const offX = box.x + (box.width - GAME_W * scale) / 2;
  const offY = box.y + (box.height - GAME_H * scale) / 2;
  await page.mouse.click(offX + x * scale, offY + y * scale);
}

/** From the city or the map, opens the first step's menu on the map. */
async function openFirstStep(page: Page, frame: Frame, stepCount: number): Promise<void> {
  await skipStories(frame);
  // City: the "Карта похода" button; on the map it hits nothing.
  await clickCanvas(page, frame, GAME_W / 2 + 230, GAME_H - 48);
  await frame.waitForTimeout(400);
  await poll("the first step's menu", 10_000, async () => {
    if (await frame.locator(".menu button").count()) return true;
    await clickCanvas(page, frame, GAME_W / (stepCount + 1), GAME_H / 2 + 40);
    await frame.waitForTimeout(300);
    return undefined;
  });
}

async function session(frame: Frame): Promise<{ token: string; playerId: string }> {
  return frame.evaluate(() => JSON.parse(localStorage.getItem("knight.session")!));
}

async function answeredInLrs(playerId: string): Promise<Statement[]> {
  return lrs.query({
    agent: { objectType: "Agent", account: { homePage: profile.accountHomePage, name: playerId } },
    verb: "http://adlnet.gov/expapi/verbs/answered",
    since: started.toISOString(),
  });
}

// ---------- The run

async function main(): Promise<void> {
  step("stack is up");
  const bundle = (await (await fetch(`${GATEWAY}/content/bundle`)).json()) as ContentBundle;
  check(bundle.content_hash, `gateway at ${GATEWAY} serves content ${bundle.content_hash}`);
  check((await fetch(CLIENT)).ok, `game client at ${CLIENT}`);
  const track = bundle.tracks[0]!;
  const steps = track.chapters.flatMap((c) => c.steps);
  const first = steps[0]!;
  const module = bundle.modules.find((m) => m.module_id === first.module_id)!;

  step(`a new student "${student}" in the test course`);
  execFileSync("docker", ["compose", "exec", "-T", "-e", `KNIGHT_E2E_STUDENT=${student}`, "-e", `KNIGHT_E2E_PASSWORD=${PASSWORD}`, "moodle", "php", "/provision/provision.php"], {
    stdio: ["ignore", "ignore", "inherit"],
  });

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  let current: Page | undefined;
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await moodleLogin(context);
    current = page;

    step(`LTI 1.3 launch of "${module.title.en}" from Moodle`);
    const frame = await openActivity(page, module.title.en);
    const { token, playerId } = await session(frame);
    const me = await (await fetch(`${GATEWAY}/session/me`, { headers: { authorization: `Bearer ${token}` } })).json();
    check(me.lti?.module_id === module.module_id && me.lti?.grades, `the game runs in Moodle's iframe as ${playerId}, bound to ${module.module_id}, with AGS`);
    check(psql("knight", `SELECT count(*) FROM lti_identities WHERE player_id = '${playerId}'`) === "1", "the LMS user is linked to the player in Postgres");

    await skipStories(frame);
    await frame.locator("#game canvas").waitFor();

    const played: Played = { answers: 0, wrong: [] };
    const wins = first.encounters?.wins_before_boss ?? 0;
    for (let i = 0; i < wins; i++) {
      const offline = i > 0;
      step(`battle ${i + 1} of ${wins}${offline ? " (offline)" : ""}`);
      await context.setOffline(offline);
      await openFirstStep(page, frame, steps.length);
      await clickMenu(frame, "В бой");
      const title = await fight(frame, bundle, played, true);
      check(title.startsWith("Победа"), `won: ${title}`);
      await clickMenu(frame, /На карту|В город/);
    }
    await context.setOffline(false);
    // The game drains its offline queue when the network returns.
    await frame.evaluate(() => window.dispatchEvent(new Event("online")));

    step("the module boss");
    await openFirstStep(page, frame, steps.length);
    await clickMenu(frame, "Босс");
    const bossTitle = await fight(frame, bundle, played, false);
    const wonAt = Date.now();
    check(bossTitle.includes("Модуль освоен"), `boss defeated: ${bossTitle}`);
    await clickMenu(frame, /В город|На карту/);
    await skipStories(frame);

    step("the grade in the Moodle gradebook (AGS)");
    const grade = await poll("the grade in Moodle", GRADE_DEADLINE_MS, async () => {
      const v = psql(
        "moodle",
        `SELECT g.finalgrade FROM mdl_grade_grades g JOIN mdl_grade_items gi ON gi.id = g.itemid JOIN mdl_user u ON u.id = g.userid
         WHERE u.username = '${student}' AND gi.itemname = 'Knight of Words: ${module.title.en.replaceAll("'", "''")}' AND g.finalgrade IS NOT NULL`,
      );
      return v ? Number(v) : undefined;
    });
    check(grade === 100, `"Knight of Words: ${module.title.en}" = ${grade}/100, ${Math.round((Date.now() - wonAt) / 1000)} s after the victory`);

    step("xAPI in the LRS");
    const statements = await poll("every answer in the LRS", 60_000, async () => {
      const s = await answeredInLrs(playerId);
      return s.length >= played.answers ? s : undefined;
    });
    const ids = new Set(statements.map((s) => s.id));
    check(statements.length === played.answers && ids.size === played.answers, `${played.answers} answers → ${statements.length} answered statements, ${ids.size} distinct ids (two battles were offline)`);

    const wrong = played.wrong[0]!;
    const errors = await conceptErrors(lrs, profile, wrong.conceptId, { since: new Date(Date.now() - 7 * 24 * 3600 * 1000), playerId });
    const mine = played.wrong.filter((w) => w.conceptId === wrong.conceptId);
    check(
      errors.length === mine.length && mine.every((w) => errors.some((e) => e.taskId === w.taskId && e.response === w.response && e.errorType === w.errorType)),
      `the week's errors on ${wrong.conceptId}: ${errors.map((e) => `"${e.response}" (${e.errorType})`).join(", ")}`,
    );

    step("a resent offline queue creates no duplicates");
    const resend = await fetch(`${GATEWAY}/xapi/statements`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(statements.map(({ id, actor, verb, object, result, context, timestamp }) => ({ id, actor, verb, object, result, context, timestamp }))),
    });
    const resent = await resend.json();
    check(resend.status === 202 && resent.new === 0, `gateway accepted ${resent.accepted} again, ${resent.new} new`);
    await new Promise((r) => setTimeout(r, 2000));
    check((await answeredInLrs(playerId)).length === played.answers, "the LRS still holds each answer once");

    step("the city on a second device");
    await page.waitForTimeout(4000); // the backup leaves a few seconds after the last save
    const other = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const otherFrame = await openActivity(await moodleLogin(other), module.title.en);
    const restored = await poll("restored progress", 15_000, async () => {
      const p = await otherFrame.evaluate(async (dbName) => {
        const db = await new Promise<IDBDatabase>((res, rej) => {
          const r = indexedDB.open(dbName);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        return new Promise<unknown>((res) => {
          const r = db.transaction("kv").objectStore("kv").get("progress");
          r.onsuccess = () => res(r.result);
          r.onerror = () => res(undefined);
        });
      }, `knight-of-words:${playerId}`);
      return (p as { modules?: Record<string, { bossPassed?: boolean }> } | undefined)?.modules?.[module.module_id]?.bossPassed ? p : undefined;
    });
    check(restored, `a fresh browser finds ${module.module_id} mastered`);
    await other.close();
  } catch (e) {
    // What the browser showed when it failed, for CI artifacts.
    await current?.screenshot({ path: new URL("./.artifacts/failure.png", import.meta.url).pathname }).catch(() => undefined);
    throw e;
  } finally {
    await browser.close();
  }
  console.log("\nLMS end-to-end: all checks passed");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
