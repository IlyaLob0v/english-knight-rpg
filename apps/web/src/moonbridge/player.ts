import type { Character, Emotion, Episode, MoonbridgeContent, Place } from "@moonbridge/content";
import type { Learner } from "../core/learner.js";
import { el } from "../ui/dom.js";
import { askTask, showFeedback } from "../ui/task-panel.js";
import { EpisodeRunner } from "./runner.js";

export interface PlayerDeps {
  content: MoonbridgeContent;
  learner: Learner;
  mediaBase: string;
}

export interface EpisodeResult {
  episodeId: string;
  /** Task answers: how many of the tasks shown were right on the first try. */
  firstTry: { right: number; total: number };
  path: string[];
}

/**
 * Plays one episode as a visual novel: the place behind, the speaker's portrait with an
 * emotion, a line or a task in the dialog box. Right and wrong answers lead wherever the
 * episode's JSON says; this file has no story in it.
 */
export async function playEpisode(root: HTMLElement, episode: Episode, d: PlayerDeps): Promise<EpisodeResult> {
  const place = d.content.places.find((p) => p.place_id === episode.place_id)!;
  const characters = new Map(d.content.characters.map((c) => [c.character_id, c]));
  const runner = new EpisodeRunner(episode);
  const firstTry = new Map<string, boolean>();
  d.learner.resetAttempts();

  const portrait = el("div", { class: "portrait" });
  const speaker = el("div", { class: "speaker" });
  const box = el("div", { class: "dialog", "aria-live": "polite" });
  const scene = el(
    "section",
    { class: "scene", "data-episode": episode.episode_id, "data-place": place.place_id },
    background(place, d.mediaBase),
    el("div", { class: "scene-title" }, episode.title.ru),
    portrait,
    el("div", { class: "dialog-wrap" }, speaker, box),
  );
  root.replaceChildren(scene);

  const show = (who: string | undefined, emotion: Emotion | undefined) => {
    const c = who ? characters.get(who) : undefined;
    speaker.textContent = c?.name ?? "";
    speaker.hidden = !c;
    scene.dataset.speaker = who ?? "narrator";
    portrait.replaceChildren(...(c ? [portraitOf(c, emotion ?? "neutral", d.mediaBase)] : []));
  };

  while (!runner.finished) {
    const step = runner.current;
    scene.dataset.step = step.id;
    if (step.kind === "line") {
      show(step.speaker === "narrator" ? undefined : step.speaker, step.emotion);
      box.classList.toggle("narration", step.speaker === "narrator");
      await line(box, step.text.en, step.text.ru);
      runner.next();
    } else if (step.kind === "task") {
      show(step.speaker, step.emotion);
      box.classList.remove("narration");
      const task = d.learner.task(step.task_id);
      const answer = await askTask(box, task, { mediaBase: d.mediaBase });
      const result = await d.learner.answer(task.task_id, answer, { mode: "moonbridge_episode", episode_id: episode.episode_id, step_id: step.id });
      if (!firstTry.has(step.id)) firstTry.set(step.id, result.outcome.correct);
      if (!(result.outcome.correct && result.outcome.match === "accepted")) {
        const label = result.outcome.errorType ? d.learner.bundle.taxonomy.error_types.find((t) => t.id === result.outcome.errorType)?.label.ru : undefined;
        await showFeedback(box, result.outcome, label);
      }
      runner.answer(result.outcome.correct);
    }
  }
  void d.learner.sync();
  return {
    episodeId: episode.episode_id,
    firstTry: { right: [...firstTry.values()].filter(Boolean).length, total: firstTry.size },
    path: runner.path,
  };
}

function line(box: HTMLElement, en: string, ru: string | undefined): Promise<void> {
  return new Promise((resolve) => {
    const text = el("p", { class: "line-text", lang: "en" }, en);
    const parts: HTMLElement[] = [text];
    if (ru) {
      const translation = el("p", { class: "line-ru", lang: "ru", hidden: "" }, ru);
      const toggle = el("button", { class: "link", type: "button", onclick: () => (translation.toggleAttribute("hidden"), toggle.remove()) }, "Перевод");
      parts.push(translation, toggle);
    }
    const next = el("button", { class: "primary next", onclick: () => resolve() }, "Дальше");
    box.replaceChildren(...parts, next);
    next.focus();
  });
}

/** The place's art, or a plain backdrop with its name until the illustrator's file is there. */
function background(place: Place, mediaBase: string): HTMLElement {
  const bg = el("div", { class: "backdrop", "data-place": place.place_id }, el("span", { class: "backdrop-name" }, place.name.en));
  const img = el("img", { src: `${mediaBase}/${place.background}`, alt: "" }) as HTMLImageElement;
  img.addEventListener("load", () => bg.classList.add("has-art"));
  img.addEventListener("error", () => img.remove());
  bg.prepend(img);
  return bg;
}

function portraitOf(c: Character, emotion: Emotion, mediaBase: string): HTMLElement {
  const path = c.portraits[emotion] ?? c.portraits.neutral;
  const frame = el("figure", { class: "portrait-frame", "data-character": c.character_id, "data-emotion": emotion });
  const stub = el("div", { class: "portrait-stub" }, el("span", { class: "initial" }, c.name.slice(0, 1)), el("span", { class: "species" }, c.species.ru));
  const img = el("img", { src: `${mediaBase}/${path}`, alt: `${c.name}` }) as HTMLImageElement;
  img.addEventListener("load", () => stub.remove());
  img.addEventListener("error", () => img.remove());
  frame.append(img, stub);
  return frame;
}
