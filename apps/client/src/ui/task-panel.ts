import type { Task } from "@knight/content";
import type { CheckOutcome, Response } from "@knight/learning";
import type { Strike } from "../game/battle.js";
import { el } from "./dom.js";

export interface Answer {
  response: Response;
  hintUsed: boolean;
  durationMs: number;
}

const TYPE_LABEL: Record<Task["type"], string> = {
  choice: "Выбери вариант",
  gap_fill: "Заполни пропуск",
  transform: "Перестрой предложение",
  order_words: "Собери предложение",
};

/**
 * Renders a task by its type and resolves with the player's answer. Everything the
 * player reads comes from the task itself: this file holds no task text.
 */
export function askTask(root: HTMLElement, task: Task, now: () => number = performance.now.bind(performance)): Promise<Answer> {
  return new Promise((resolve) => {
    const started = now();
    let hintUsed = false;
    const p = task.presentation;

    const panel = el("div", { class: "task" });
    panel.append(el("div", { class: "task-type" }, p.instruction_ru ?? TYPE_LABEL[task.type]));
    if (p.source) panel.append(el("blockquote", { class: "task-source" }, p.source));
    panel.append(el("div", { class: "task-prompt", lang: "en" }, p.prompt));

    const timer = el("div", { class: "task-timer" });
    const limit = task.combat?.time_limit_s;
    let tick: ReturnType<typeof setInterval> | undefined;
    if (limit) {
      const bar = el("span");
      timer.append(bar);
      tick = setInterval(() => {
        const left = Math.max(0, 1 - (now() - started) / (limit * 1000));
        bar.style.width = `${left * 100}%`;
        timer.classList.toggle("late", left < 0.25);
      }, 200);
    }

    const finish = (response: Response) => {
      if (tick) clearInterval(tick);
      root.replaceChildren();
      resolve({ response, hintUsed, durationMs: Math.round(now() - started) });
    };

    const body = el("div", { class: "task-body" });
    let focus: HTMLElement | undefined;
    if (task.type === "choice") {
      for (const option of p.options ?? []) {
        body.append(el("button", { class: "option", lang: "en", onclick: () => finish(option.id) }, option.text));
      }
    } else if (task.type === "order_words") {
      const built: string[] = [];
      const line = el("div", { class: "order-line", lang: "en" });
      const bank = el("div", { class: "order-bank", lang: "en" });
      const render = () => {
        line.replaceChildren(...built.map((w, i) => el("button", { class: "token placed", onclick: () => (built.splice(i, 1), render()) }, w)));
        const left = [...(p.tokens ?? [])];
        for (const w of built) left.splice(left.indexOf(w), 1);
        bank.replaceChildren(...left.map((w) => el("button", { class: "token", onclick: () => (built.push(w), render()) }, w)));
        submit.disabled = left.length > 0;
      };
      const submit = el("button", { class: "primary", onclick: () => finish([...built]) }, "Ударить") as HTMLButtonElement;
      body.append(line, bank, submit);
      render();
    } else {
      const input = el("input", { type: "text", class: "answer", lang: "en", autocomplete: "off", autocapitalize: "off", spellcheck: "false" }) as HTMLInputElement;
      const submit = el("button", { class: "primary", type: "submit" }, "Ударить");
      const form = el("form", { class: "answer-form", onsubmit: (e: Event) => (e.preventDefault(), input.value.trim() && finish(input.value)) }, input, submit);
      body.append(form);
      focus = input;
    }
    panel.append(body);

    if (p.hint) {
      const hint = el("div", { class: "task-hint", hidden: "" }, p.hint);
      const btn = el("button", { class: "link", onclick: () => ((hintUsed = true), hint.removeAttribute("hidden"), btn.remove()) }, "Подсказка");
      panel.append(btn, hint);
    }
    panel.append(timer);
    root.replaceChildren(panel);
    focus?.focus();
  });
}

const STRIKE_TITLE: Record<Strike["kind"], string> = {
  hit: "Удар!",
  graze: "Опечатка: скользящий удар",
  miss: "Промах",
};

/** Shows what happened after an error or a typo, with the author's feedback; resolves when the player continues. */
export function showFeedback(root: HTMLElement, outcome: CheckOutcome, strike: Strike, errorLabel?: string): Promise<void> {
  return new Promise((resolve) => {
    const box = el("div", { class: `feedback ${strike.kind}` });
    box.append(el("div", { class: "feedback-title" }, STRIKE_TITLE[strike.kind]));
    if (!outcome.correct) {
      box.append(
        el("div", {}, "Твой ответ: ", el("span", { class: "wrong", lang: "en" }, outcome.response || "—")),
        el("div", {}, "Верно: ", el("span", { class: "right", lang: "en" }, outcome.correctForm)),
      );
      if (outcome.feedback) box.append(el("div", { class: "feedback-note" }, outcome.feedback));
      else if (errorLabel && outcome.match !== "unclassified") box.append(el("div", { class: "feedback-note" }, errorLabel));
    }
    const next = el("button", { class: "primary", onclick: () => (root.replaceChildren(), resolve()) }, "Дальше");
    box.append(next);
    root.replaceChildren(box);
    next.focus();
  });
}
