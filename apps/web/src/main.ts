import type { ContentBundle } from "@moonbridge/content";
import { Learner } from "./core/learner.js";
import { Api, GatewaySink, localSessionStorage, renewGuest, startSession } from "./net/api.js";
import { ProgressBackup } from "./net/backup.js";
import { askProfile, loadProfile, saveProfile } from "./platform/login.js";
import { renderToday } from "./platform/today.js";
import { IdbJournal, IdbKeyValue, IdbOutboxStore, openPlayerDb, type KeyValue } from "./storage/idb.js";
import { el } from "./ui/dom.js";
import "./style.css";

const root = document.getElementById("app")!;
/** Must match CACHE in public/sw.js. */
const SHELL_CACHE = "shell-v1";

/**
 * Puts the page and every built file loaded so far into the service worker's cache, so the
 * next start works offline. Called after each screen: the Moonbridge chunk is cached once the
 * student has opened the section online, and never downloaded ahead of that.
 */
function cacheLoadedAssets(): void {
  if (!import.meta.env.PROD || !("caches" in window)) return;
  const urls = performance
    .getEntriesByType("resource")
    .map((e) => new URL(e.name))
    .filter((u) => u.origin === location.origin && u.pathname.startsWith("/assets/"))
    .map((u) => u.pathname);
  void caches
    .open(SHELL_CACHE)
    .then((c) => c.addAll(["/", ...new Set(urls)]))
    .catch((e) => console.warn("offline cache", e));
}

function fatal(message: string, detail?: unknown): void {
  console.error(message, detail);
  root.replaceChildren(el("div", { class: "card" }, el("h1", {}, "Не получилось открыть платформу"), el("p", {}, message)));
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
  const apiBase = import.meta.env.VITE_API_BASE ?? "/api";
  const api = new Api(apiBase);
  const profile = loadProfile() ?? (await askProfile(root));
  saveProfile(profile);
  root.replaceChildren(el("div", { class: "card" }, el("p", {}, "Загрузка…")));

  const { session } = await startSession(api, localSessionStorage, "");
  const db = await openPlayerDb(session.playerId);
  const local = new IdbKeyValue(db);
  const bundle = await loadBundle(api, local);
  if (!bundle) return fatal("Нет связи с сервером, а сохранённого курса на этом устройстве ещё нет.");

  const kv = new ProgressBackup(local, api, () => session.token);
  await kv.restore();
  if (!(await kv.get("profile"))) await kv.set("profile", profile);

  let renewing: Promise<unknown> | undefined;
  const sink = new GatewaySink(
    api,
    () => session.token,
    () => {
      if (session.kind !== "guest" || renewing) return;
      renewing = renewGuest(api, session.playerId)
        .then((s) => (Object.assign(session, s), localSessionStorage.save(session)))
        .catch(() => undefined)
        .finally(() => (renewing = undefined));
    },
  );
  const learner = await Learner.load({
    bundle,
    playerId: session.playerId,
    registration: session.registration,
    xapiBaseIri: session.xapiBaseIri,
    kv,
    journal: new IdbJournal(db),
    outboxStore: new IdbOutboxStore(db),
    sink,
  });
  const sync = () => void learner.sync().then(() => kv.push());
  sync();
  window.addEventListener("online", sync);
  setInterval(sync, 30_000);

  const mediaBase = `${apiBase.replace(/\/$/, "")}/content/media`;
  const navigate = (path: string) => {
    if (path !== location.pathname) history.pushState(null, "", path);
    void route();
  };
  const route = async () => {
    const path = location.pathname;
    document.body.dataset.section = path.startsWith("/moonbridge") ? "moonbridge" : "platform";
    if (path === "/moonbridge" || path.startsWith("/moonbridge/")) {
      // A separate chunk: the platform never downloads the game unless the student opens it.
      const { mountMoonbridge } = await import("./moonbridge/section.js");
      cacheLoadedAssets();
      return mountMoonbridge(root, path, { learner, kv, mediaBase, navigate });
    }
    if (path !== "/") history.replaceState(null, "", "/");
    await renderToday(root, { profile, learner, kv });
    cacheLoadedAssets();
  };
  document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.("a[data-link]") as HTMLAnchorElement | null;
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    navigate(new URL(a.href).pathname);
  });
  window.addEventListener("popstate", () => void route());
  await route();
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("service worker", e)));
}

boot().catch((e) => fatal(e instanceof Error ? e.message : String(e), e));
