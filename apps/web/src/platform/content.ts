import { ApiError, type Api, type ContentState, type SheetInput, type SheetResult } from "../net/api.js";
import type { KeyValue } from "../storage/idb.js";
import { el } from "../ui/dom.js";
import { when } from "./school.js";

// The course content from the teacher's side: download it as a sheet, edit it in Google Sheets,
// check it and publish it. Students get the new content the next time they open the platform.

const SHEET_URL_KEY = "content-sheet-url";

export interface ContentPageDeps {
  api: Api;
  token: string | undefined;
  kv: KeyValue;
  now?: Date;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`;
}

export function contentCounts(c: { units: number; tasks: number; episodes: number }): string {
  return [plural(c.units, "юнит", "юнита", "юнитов"), plural(c.tasks, "задание", "задания", "заданий"), plural(c.episodes, "эпизод", "эпизода", "эпизодов")].join(", ");
}

function stateText(s: ContentState, now: Date): string {
  if (!s.published) return `${contentCounts(s)}. Контент из репозитория: из таблицы ещё не публиковали.`;
  const from = s.published.source.startsWith("https://") ? "из Google Таблицы" : `из файла ${s.published.source}`;
  return `${contentCounts(s)}. Опубликовано ${when(new Date(s.published.at), now)}${s.published.by ? `, ${s.published.by}` : ""}, ${from}.`;
}

function messageOf(e: unknown): string {
  return e instanceof ApiError && e.userMessage ? e.userMessage : "Не получилось. Проверьте интернет и попробуйте ещё раз.";
}

/** What the check found: errors to fix first, then what publishing would change. */
export function sheetReport(r: SheetResult): HTMLElement {
  const errors = r.issues.filter((i) => i.severity === "error");
  const warnings = r.issues.filter((i) => i.severity === "warning");
  const item = (i: SheetResult["issues"][number]) => el("li", {}, i.where ? el("b", {}, `${i.where}: `) : "", i.message);
  const parts: HTMLElement[] = [];
  if (errors.length) {
    parts.push(el("p", { class: "form-error" }, `Нужно исправить: ${errors.length}. Поправьте таблицу и проверьте ещё раз.`), el("ul", { class: "sheet-errors" }, ...errors.map(item)));
  } else if (r.summary) {
    const s = r.summary;
    parts.push(el("p", { class: "sheet-ok" }, `Ошибок нет: ${contentCounts({ units: s.units.length, tasks: s.tasks, episodes: s.episodes })}.`));
    const name = (id: string) => {
      const title = s.units.find((u) => u.id === id)?.title;
      return title ? `«${title}»` : id;
    };
    const changes = [
      s.added.length ? `новые юниты: ${s.added.map(name).join(", ")}` : "",
      s.changed.length ? `изменены: ${s.changed.map(name).join(", ")}` : "",
      s.removed.length ? `убраны: ${s.removed.join(", ")} — ученики перестанут их видеть` : "",
    ].filter(Boolean);
    parts.push(el("p", { class: "muted" }, changes.length ? `${changes.join("; ")}.` : "По сравнению с тем, что сейчас у учеников, ничего не меняется."));
  }
  if (warnings.length) parts.push(el("details", {}, el("summary", {}, `Замечания: ${warnings.length}`), el("ul", { class: "sheet-warnings" }, ...warnings.map(item))));
  return el("div", { class: "sheet-report", "data-sheet-ok": String(r.ok) }, ...parts);
}

export async function renderContent(root: HTMLElement, d: ContentPageDeps): Promise<void> {
  const back = el("a", { href: "/teacher", "data-link": "", class: "back" }, "← Кабинет");
  const page = (...cards: HTMLElement[]) =>
    root.replaceChildren(el("div", { class: "teacher content-page" }, el("header", { class: "section-head" }, back, el("h1", {}, "Контент курса")), ...cards));
  if (!d.token) return page(el("div", { class: "card" }, el("p", { class: "form-error" }, "Контент меняется, когда есть связь с сервером.")));
  const token = d.token;
  let state: ContentState;
  try {
    state = await d.api.contentState(token);
  } catch (e) {
    return page(el("div", { class: "card" }, el("p", { class: "form-error" }, messageOf(e))));
  }
  const now = d.now ?? new Date();
  const current = el("p", { "data-content-hash": state.content_hash }, stateText(state, now));

  const download = el("button", { type: "button", "data-download-sheet": "" }, "Скачать таблицу (.xlsx)") as HTMLButtonElement;
  download.addEventListener("click", async () => {
    download.disabled = true;
    try {
      const blob = await d.api.contentSheet(token);
      const a = el("a", { href: URL.createObjectURL(blob), download: "moonbridge-content.xlsx" }) as HTMLAnchorElement;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) {
      current.after(el("p", { class: "form-error" }, messageOf(e)));
    } finally {
      download.disabled = false;
    }
  });

  if (!state.editable) {
    return page(el("section", { class: "card" }, el("h2", {}, "Сейчас у учеников"), current, download, el("p", { class: "muted" }, "На этом сервере публикация из таблицы выключена: контент меняет Илья.")));
  }

  const saved = (await d.kv.get<string>(SHEET_URL_KEY)) ?? (state.published?.source.startsWith("https://") ? state.published.source : "");
  const link = el("input", { class: "answer", type: "url", inputmode: "url", name: "sheet-url", placeholder: "https://docs.google.com/spreadsheets/d/…", "aria-label": "Ссылка на Google Таблицу", value: saved }) as HTMLInputElement;
  const fileInput = el("input", { type: "file", class: "file-input", accept: ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "aria-label": "Файл .xlsx" }) as HTMLInputElement;
  const chosen = el("p", { class: "muted" });
  const report = el("div", { class: "sheet-result", role: "status" });
  const check = el("button", { type: "button", class: "primary", "data-check-sheet": "" }, "Проверить") as HTMLButtonElement;
  const publish = el("button", { type: "button", class: "primary", "data-publish-sheet": "", hidden: "" }, "Опубликовать") as HTMLButtonElement;

  const input = (): SheetInput | undefined => fileInput.files?.[0] ?? (link.value.trim() ? { url: link.value.trim() } : undefined);
  const reset = () => {
    publish.hidden = true;
    report.replaceChildren();
  };
  link.addEventListener("input", () => {
    if (link.value) fileInput.value = "";
    chosen.textContent = "";
    reset();
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    chosen.textContent = f ? f.name : "";
    reset();
  });

  const run = async (what: "check" | "publish") => {
    const sheet = input();
    if (!sheet) {
      report.replaceChildren(el("p", { class: "form-error" }, "Вставьте ссылку на таблицу или выберите файл .xlsx."));
      return;
    }
    if (!(sheet instanceof File)) await d.kv.set(SHEET_URL_KEY, sheet.url);
    check.disabled = publish.disabled = true;
    report.replaceChildren(el("p", { class: "muted" }, what === "check" ? "Проверяю таблицу…" : "Публикую…"));
    try {
      const r = await d.api.sheet(token, what, sheet);
      report.replaceChildren(sheetReport(r));
      if (what === "publish" && r.ok && r.content) {
        state = r.content;
        current.textContent = stateText(state, new Date());
        current.dataset.contentHash = state.content_hash;
        report.prepend(el("p", { class: "sheet-ok", "data-published": "" }, "Опубликовано. Ученики увидят новое, когда откроют платформу."));
        publish.hidden = true;
      } else publish.hidden = what === "publish" || !r.ok;
    } catch (e) {
      report.replaceChildren(el("p", { class: "form-error" }, messageOf(e)));
    } finally {
      check.disabled = publish.disabled = false;
    }
  };
  check.addEventListener("click", () => void run("check"));
  publish.addEventListener("click", () => void run("publish"));

  page(
    el("section", { class: "card" }, el("h2", {}, "Сейчас у учеников"), current, download),
    el(
      "section",
      { class: "card sheet-form" },
      el("h2", {}, "Обновить из таблицы"),
      el(
        "ol",
        { class: "steps muted" },
        el("li", {}, "Скачайте таблицу и откройте её в Google Таблицах (Файл → Импортировать), или правьте ту, что уже есть."),
        el("li", {}, "Откройте доступ по ссылке: «Все, у кого есть ссылка — читатель»."),
        el("li", {}, "Вставьте ссылку сюда и нажмите «Проверить». Если ошибок нет, нажмите «Опубликовать»."),
      ),
      el("label", { class: "field" }, "Ссылка на Google Таблицу", link),
      el("label", { class: "file-pick button" }, fileInput, "Или выбрать файл .xlsx"),
      chosen,
      el("div", { class: "actions" }, check, publish),
      report,
    ),
  );
}
