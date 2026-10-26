import type { ErrorReport } from "../game/stats.js";
import { el } from "./dom.js";

const PERIODS: { label: string; days?: number }[] = [{ label: "7 дней", days: 7 }, { label: "30 дней", days: 30 }, { label: "Всё время" }];

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * The error statistics screen: top error types, concepts by errors with their recall
 * now, and unclassified answers (the author's list of known_errors to add).
 * Resolves when the player closes it.
 */
export function showStats(root: HTMLElement, load: (days?: number) => Promise<ErrorReport>, repairThreshold: number): Promise<void> {
  return new Promise((resolve) => {
    const box = el("div", { class: "stats", role: "dialog", "aria-label": "Статистика ошибок" });
    const close = () => (root.replaceChildren(), resolve());
    let period = PERIODS[0]!;

    const render = async () => {
      const r = await load(period.days);
      const tabs = el(
        "div",
        { class: "tabs" },
        ...PERIODS.map((p) => el("button", { "aria-pressed": String(p === period), onclick: () => ((period = p), void render()) }, p.label)),
      );
      const wrong = r.total - r.correct;
      const parts: Node[] = [
        el("h2", {}, "Статистика ошибок"),
        el("div", { class: "muted" }, "Строится из журнала попыток: те же записи уходят в xAPI."),
        tabs,
        el("div", {}, r.total ? `Ответов: ${r.total}, верных ${pct(r.correct / r.total)}, ошибок ${wrong}` : "За этот период ответов нет."),
      ];

      if (r.topErrorTypes.length) {
        const max = Math.max(...r.topErrorTypes.map((t) => t.count));
        parts.push(
          el("h3", {}, "Топ-5 типов ошибок"),
          table(
            ["Тип ошибки", "Сколько"],
            r.topErrorTypes.map((t) => [
              el("span", {}, el("span", { class: "bar", style: `width:${Math.max(4, (t.count / max) * 120)}px` }), t.label),
              num(t.count),
            ]),
          ),
        );
      }

      if (r.concepts.length) {
        parts.push(
          el("h3", {}, "Концепты"),
          table(
            ["Концепт", "Модуль", "Ответов", "Ошибок", "Помнишь сейчас"],
            r.concepts.map((c) => [
              el("span", { lang: "en" }, c.label),
              c.moduleTitle,
              num(c.attempts),
              num(c.errors),
              c.retrievability === undefined
                ? num("—")
                : el("span", { class: `${c.retrievability < repairThreshold ? "recall-low" : "recall-ok"}` }, pct(c.retrievability)),
            ]),
          ),
        );
      }

      parts.push(el("h3", {}, "Нераспознанные ответы"));
      if (r.unclassified.length) {
        parts.push(
          el("div", { class: "muted" }, "Частые из них стоит добавить в known_errors задания: тогда игра объяснит ошибку."),
          table(
            ["Задание", "Ответ", "Верно", "Раз"],
            r.unclassified.map((u) => [
              el("span", {}, el("span", { lang: "en" }, u.prompt), el("div", { class: "muted" }, `${u.taskId} · ${u.moduleTitle}`)),
              el("span", { lang: "en" }, u.response),
              el("span", { lang: "en" }, u.correctForm),
              num(u.count),
            ]),
          ),
        );
      } else {
        parts.push(el("div", { class: "muted" }, "Нет: каждая ошибка распознана."));
      }
      parts.push(el("div", { class: "menu-actions" }, el("button", { class: "primary", onclick: close }, "Закрыть")));
      box.replaceChildren(...parts);
    };

    root.replaceChildren(box);
    void render();
  });
}

function num(v: number | string): HTMLElement {
  return el("span", { "data-num": "" }, String(v));
}

function table(head: string[], rows: (string | Node)[][]): HTMLElement {
  return el(
    "table",
    {},
    el("thead", {}, el("tr", {}, ...head.map((h) => el("th", {}, h)))),
    el(
      "tbody",
      {},
      ...rows.map((cells) =>
        el("tr", {}, ...cells.map((c) => (c instanceof HTMLElement && c.hasAttribute("data-num") ? el("td", { class: "num" }, c.textContent ?? "") : el("td", {}, c)))),
      ),
    ),
  );
}
