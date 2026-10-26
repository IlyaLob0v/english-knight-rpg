import type { ContentBundle } from "@knight/content";
import Phaser from "phaser";
import { Game } from "./game/game.js";
import { Api, GatewaySink, localSessionStorage, renewGuest, startSession } from "./net/api.js";
import { BattleScene } from "./scenes/BattleScene.js";
import { CityScene } from "./scenes/CityScene.js";
import { MapScene } from "./scenes/MapScene.js";
import type { Services } from "./scenes/services.js";
import { IdbJournal, IdbKeyValue, IdbOutboxStore, openPlayerDb, type KeyValue } from "./storage/idb.js";
import { playStory } from "./ui/dialog.js";
import { el } from "./ui/dom.js";
import "./style.css";

const ui = document.getElementById("ui")!;

function fatal(message: string, detail?: unknown): void {
  console.error(message, detail);
  ui.replaceChildren(el("div", { class: "menu" }, el("div", { class: "menu-title" }, "Игра не запустилась"), el("div", { class: "menu-line" }, message)));
}

/** Fresh bundle from the gateway when it is reachable, the cached one otherwise. */
async function loadBundle(api: Api, kv: KeyValue): Promise<ContentBundle | undefined> {
  const cached = await kv.get<ContentBundle>("content-bundle");
  try {
    const fresh = await api.bundle(cached?.content_hash);
    if (fresh === "not-modified") return cached;
    await kv.set("content-bundle", fresh);
    return fresh;
  } catch (e) {
    console.warn("content bundle: using the cached copy", e);
    return cached;
  }
}

async function boot(): Promise<void> {
  ui.replaceChildren(el("div", { class: "menu" }, el("div", { class: "menu-title" }, "Загрузка…")));
  const api = new Api(import.meta.env.VITE_API_BASE ?? "/api");
  const { session } = await startSession(api, localSessionStorage, location.hash);
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);

  const db = await openPlayerDb(session.playerId);
  const kv = new IdbKeyValue(db);
  const bundle = await loadBundle(api, kv);
  if (!bundle) return fatal("Нет связи с сервером, а сохранённого контента ещё нет. Запусти шлюз: pnpm dev:server.");

  let renewing: Promise<unknown> | undefined;
  const sink = new GatewaySink(
    api,
    () => session.token,
    () => {
      // Guest sessions renew themselves under the same player id; an LMS session needs a new launch.
      if (session.kind !== "guest" || renewing) return;
      renewing = renewGuest(api, session.playerId)
        .then((s) => (Object.assign(session, s), localSessionStorage.save(session)))
        .catch(() => undefined)
        .finally(() => (renewing = undefined));
    },
  );
  const game = await Game.load({
    bundle,
    playerId: session.playerId,
    registration: session.registration,
    xapiBaseIri: session.xapiBaseIri,
    kv,
    journal: new IdbJournal(db),
    outboxStore: new IdbOutboxStore(db),
    sink,
    reportModuleResult: (r) => {
      if (!session.token) throw new Error("offline");
      return api.moduleResult(session.token, r);
    },
  });
  await game.launched();
  window.addEventListener("online", () => void game.sync());

  ui.replaceChildren();
  const intro = await game.storyOnce(game.track.chapters[0]?.story_intro);
  if (intro) await playStory(ui, intro);

  const phaser = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    width: 960,
    height: 600,
    backgroundColor: "#1d2a1f",
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    // The city is the hub: patrol, repairs and statistics start there; the map leads to new modules.
    scene: [CityScene, MapScene, BattleScene],
  });
  phaser.registry.set("services", { game, ui } satisfies Services);
}

boot().catch((e) => fatal(e instanceof Error ? e.message : String(e), e));
