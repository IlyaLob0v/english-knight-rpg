// End-to-end check of week 3 on a phone screen (390 × 844):
//
//   sign-in → Today → Moonbridge (a separate chunk, no second sign-in) → the hotel map →
//   the unit 1 episode at the reception, a wrong answer into its funny branch and back,
//   to the end → the episode marked done after a reload, and every answer accepted by
//   the gateway's xAPI intake.
//
// Starts its own gateway (in memory, live content) and the built platform (vite preview).
// Run: pnpm e2e        (HEADED=1 to watch it)
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type { ContentBundle, Task } from "@moonbridge/content";
import { chromium, type Page } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const ARTIFACTS = new URL(".artifacts/", import.meta.url).pathname;
const GATEWAY = "http://localhost:8787";
const WEB = "http://localhost:4173";
const EPISODE = "A1_NiceToMeetYou_01_check_in";

const children: ChildProcess[] = [];
function start(name: string, cmd: string, args: string[], env: Record<string, string> = {}): void {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  child.stdout!.on("data", (b) => (log += b));
  child.stderr!.on("data", (b) => (log += b));
  child.on("exit", (code) => code && code !== 143 && console.error(`${name} exited with ${code}\n${log.slice(-2000)}`));
  children.push(child);
}

async function waitFor(url: string, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await fetch(url).then((r) => r.ok, () => false)) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function step(message: string): void {
  console.log(`\n▶ ${message}`);
}

function check(ok: unknown, message: string): void {
  if (!ok) throw new Error(`FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

/** Answers the task on screen correctly, whatever its type, from the bundle the platform got. */
async function answerRight(page: Page, task: Task): Promise<void> {
  const panel = page.locator(`.task[data-task="${task.task_id}"]`);
  await panel.waitFor();
  const first = task.answer.accepted[0]!;
  switch (task.type) {
    case "choice":
    case "translate_en_ru":
      return panel.getByRole("button", { name: task.presentation.options!.find((o) => o.id === first)!.text, exact: true }).click();
    case "find_error":
      return panel.locator(".find-line button").filter({ hasText: new RegExp(`^${task.presentation.tokens![Number(first)]}$`) }).first().click();
    case "order_words":
      for (const word of first.split(" ")) await panel.locator(".order-bank button").filter({ hasText: new RegExp(`^${word.replace(/[?.]/g, "\\$&")}$`) }).first().click();
      return panel.getByRole("button", { name: "Ответить" }).click();
    default:
      await panel.getByLabel("Ответ").fill(first);
      return panel.getByRole("button", { name: "Ответить" }).click();
  }
}

async function main(): Promise<void> {
  await mkdir(ARTIFACTS, { recursive: true });
  step("Gateway and the built platform");
  start("gateway", "pnpm", ["--filter", "@moonbridge/server", "start"], { PORT: "8787", NODE_ENV: "development" });
  start("web", "pnpm", ["--filter", "@moonbridge/web", "preview", "--strictPort"]);
  await waitFor(`${GATEWAY}/health`);
  await waitFor(WEB);
  const bundle = (await (await fetch(`${GATEWAY}/content/bundle`)).json()) as ContentBundle;
  const episode = bundle.moonbridge!.episodes.find((e) => e.episode_id === EPISODE)!;
  check(episode, `the live content has the episode ${EPISODE}`);

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ru-RU" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const chunks: string[] = [];
  page.on("request", (r) => r.url().includes("/assets/") && chunks.push(new URL(r.url()).pathname));
  let accepted = 0;
  page.on("response", async (r) => {
    if (r.url().endsWith("/api/xapi/statements") && r.status() === 202) accepted += ((await r.json()) as { accepted: number }).accepted;
  });
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  try {
    step("Sign-in and Today");
    await page.goto(WEB);
    await page.getByLabel("Имя").fill("Анна");
    await page.getByRole("button", { name: "Войти" }).click();
    await page.getByRole("heading", { name: /Анна/ }).waitFor();
    check(await page.locator("[data-section=moonbridge]").isVisible(), "Today shows the Moonbridge card");
    check(!chunks.some((c) => c.includes("section-")), "the platform has not downloaded the Moonbridge chunk");
    check(await noSideScroll(), "Today fits a 390 px screen");
    await page.screenshot({ path: `${ARTIFACTS}today.png` });

    step("Into Moonbridge without signing in again");
    await page.locator("[data-section=moonbridge]").click();
    await page.waitForURL(`${WEB}/moonbridge`);
    await page.locator(".hotel-map").waitFor();
    check(chunks.some((c) => c.includes("section-")), "the Moonbridge chunk loads on demand");
    check(await page.getByLabel("Имя").count() === 0, "no second sign-in");
    check(await page.locator('.room.open[data-place="reception"]').isVisible(), "the reception is open");
    check(await noSideScroll(), "the map fits a 390 px screen");
    await page.screenshot({ path: `${ARTIFACTS}map.png` });
    await page.locator(".play-next").click();

    step("The episode, with a wrong answer first");
    const scene = page.locator(`.scene[data-episode="${EPISODE}"]`);
    await scene.waitFor();
    const at = async (id: string) => (await scene.getAttribute("data-step")) === id;
    const next = () => scene.locator(".dialog .next").click();
    await next(); // narration
    const greet = bundle.tasks["A1_NiceToMeetYou_01_hello"]!;
    await scene.locator(".task").waitFor();
    await page.screenshot({ path: `${ARTIFACTS}task.png` });
    await scene.getByRole("button", { name: greet.presentation.options!.find((o) => o.id === "b")!.text }).click();
    await scene.locator('.feedback[data-outcome="wrong"]').waitFor();
    check(await scene.locator(".feedback-note").isVisible(), "the wrong answer shows the author's feedback");
    await scene.getByRole("button", { name: "Дальше" }).click();
    check(await at("greet_wrong"), "the wrong answer leads into its branch");
    check(await scene.locator('.portrait-frame[data-emotion="upset"]').isVisible(), "Rocco is upset in that branch");
    await page.screenshot({ path: `${ARTIFACTS}wrong-branch.png` });
    await next();
    check(await at("greet"), "the branch returns to the task");

    const answered = new Set<string>();
    while (!(await page.locator("[data-episode-end]").isVisible())) {
      const stepId = await scene.getAttribute("data-step");
      const s = episode.steps.find((x) => x.id === stepId)!;
      if (s.kind === "task") {
        await answerRight(page, bundle.tasks[s.task_id]!);
        answered.add(s.id);
        // A typo or other near-miss shows feedback before the story goes on.
        if (await scene.locator(".feedback").isVisible().catch(() => false)) await scene.getByRole("button", { name: "Дальше" }).click();
      } else {
        await next();
      }
      await page.waitForFunction(
        ([sel, prev]) => document.querySelector("[data-episode-end]") || document.querySelector(sel)?.getAttribute("data-step") !== prev,
        [`.scene[data-episode="${EPISODE}"]`, stepId] as const,
      );
      check(await noSideScroll(), `step "${stepId}" fits a 390 px screen`);
    }
    check(answered.size === episode.steps.filter((x) => x.kind === "task").length, "every task of the episode was answered");
    check(await page.locator("[data-episode-end]").getByText(/Эпизод пройден/).isVisible(), "the episode ends");
    await page.screenshot({ path: `${ARTIFACTS}end.png` });

    step("After a reload");
    await page.locator("[data-episode-end] button").click();
    await page.reload();
    await page.locator(".hotel-map").waitFor();
    check(await page.locator(`.episode.done[data-episode="${EPISODE}"]`).isVisible(), "the episode stays done");
    await new Promise((r) => setTimeout(r, 1500));
    check(accepted >= answered.size + 1, `the gateway accepted ${accepted} answer statements`);
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } catch (e) {
    await page.screenshot({ path: `${ARTIFACTS}failure.png` }).catch(() => undefined);
    throw e;
  } finally {
    await browser.close();
  }
  console.log("\nAll good.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    // Each server runs in its own process group: pnpm, tsx and vite all go.
    for (const c of children) if (c.pid) process.kill(-c.pid, "SIGTERM");
  });
