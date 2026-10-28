import type { Learner } from "../core/learner.js";
import type { KeyValue } from "../storage/idb.js";
import { el } from "../ui/dom.js";
import { playEpisode } from "./player.js";
import { completeEpisode, hotelView, migrateState, studentCourse, type HotelView, type MoonbridgeState } from "./progress.js";

// The Moonbridge section. It is loaded only when the student opens /moonbridge, so the
// platform works, and stays light, without it. It keeps nothing but its own game state;
// answers go to the shared learner.

export interface SectionDeps {
  learner: Learner;
  kv: KeyValue;
  mediaBase: string;
  navigate: (path: string) => void;
}

const KEY = "moonbridge";

export async function mountMoonbridge(root: HTMLElement, path: string, d: SectionDeps): Promise<void> {
  const content = d.learner.bundle.moonbridge;
  const course = studentCourse(d.learner.bundle);
  if (!content || !course) {
    root.replaceChildren(el("div", { class: "card" }, el("h1", {}, "Moonbridge"), el("p", {}, "Раздел пока закрыт: в курсе нет эпизодов.")));
    return;
  }
  const state = migrateState(await d.kv.get(KEY));
  const episodeId = /^\/moonbridge\/episode\/([A-Za-z0-9_]+)$/.exec(path)?.[1];
  const view = hotelView(content, course, state);

  if (episodeId) {
    const playable = view.places.filter((p) => p.open).flatMap((p) => p.episodes).find((e) => e.episode.episode_id === episodeId && e.available);
    if (!playable) return d.navigate("/moonbridge");
    const result = await playEpisode(root, playable.episode, { content, learner: d.learner, mediaBase: d.mediaBase });
    const next: MoonbridgeState = completeEpisode(state, result.episodeId);
    await d.kv.set(KEY, next);
    const before = new Set(view.places.filter((p) => p.open).map((p) => p.place.place_id));
    const opened = hotelView(content, course, next).places.filter((p) => p.open && !before.has(p.place.place_id));
    root.replaceChildren(
      el(
        "div",
        { class: "card episode-end", "data-episode-end": result.episodeId },
        el("h1", {}, playable.episode.title.ru),
        el("p", {}, `Эпизод пройден. С первого раза: ${result.firstTry.right} из ${result.firstTry.total}.`),
        ...opened.map((p) => el("p", { class: "unlocked" }, `Открылось новое место: ${p.place.name.ru}`)),
        el("button", { class: "primary", onclick: () => d.navigate("/moonbridge") }, "В отель"),
      ),
    );
    return;
  }
  renderMap(root, view, d);
}

function renderMap(root: HTMLElement, view: HotelView, d: SectionDeps): void {
  const map = el("div", { class: "hotel-map" });
  for (const p of view.places) {
    const done = p.episodes.filter((e) => e.done).length;
    const room = el(
      "div",
      { class: `room ${p.open ? "open" : "locked"}`, "data-place": p.place.place_id },
      el("h2", {}, p.place.name.ru),
      el("p", { class: "muted" }, p.open ? `Эпизоды: ${done} из ${p.episodes.length}` : "Закрыто: откроется по ходу курса"),
    );
    if (p.open) {
      const list = el("ul", { class: "episodes" });
      for (const e of p.episodes.filter((x) => x.available)) {
        list.append(
          el(
            "li",
            {},
            el(
              "button",
              { class: e.done ? "episode done" : "episode", "data-episode": e.episode.episode_id, onclick: () => d.navigate(`/moonbridge/episode/${e.episode.episode_id}`) },
              `${e.done ? "✓ " : ""}${e.episode.title.ru}`,
            ),
          ),
        );
      }
      room.append(list);
    }
    map.append(room);
  }
  const play = view.next
    ? el("button", { class: "primary play-next", onclick: () => d.navigate(`/moonbridge/episode/${view.next!.episode_id}`) }, `Играть: ${view.next.title.ru}`)
    : el("p", { class: "muted" }, "Все эпизоды пройдены. Новые появятся со следующим юнитом.");
  root.replaceChildren(
    el(
      "div",
      { class: "hotel" },
      el("header", { class: "section-head" }, el("a", { href: "/", "data-link": "", class: "back" }, "← Платформа"), el("h1", {}, "Hotel Hello")),
      play,
      map,
    ),
  );
}
