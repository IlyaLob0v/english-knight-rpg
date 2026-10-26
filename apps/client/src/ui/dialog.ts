import type { Story } from "@knight/content";
import { el } from "./dom.js";

/** Plays a story scene line by line. English first; the Russian translation is one tap away. */
export function playStory(root: HTMLElement, story: Story): Promise<void> {
  return new Promise((resolve) => {
    let i = 0;
    const show = () => {
      const line = story.lines[i]!;
      const ru = el("div", { class: "story-ru", hidden: "" }, line.text.ru);
      const box = el(
        "div",
        { class: "story" },
        ...(line.speaker ? [el("div", { class: "story-speaker" }, line.speaker.en)] : []),
        el("div", { class: "story-text", lang: "en" }, line.text.en),
        ru,
        el(
          "div",
          { class: "story-actions" },
          el("button", { class: "link", onclick: () => ru.toggleAttribute("hidden") }, "Перевод"),
          el("button", { class: "primary", onclick: () => (++i < story.lines.length ? show() : (root.replaceChildren(), resolve())) }, i + 1 < story.lines.length ? "Дальше" : "В путь"),
        ),
      );
      root.replaceChildren(box);
      (box.querySelector(".primary") as HTMLElement).focus();
    };
    show();
  });
}

/** A small modal menu: a title, a few lines of text and buttons. */
export function showMenu(
  root: HTMLElement,
  title: string,
  lines: string[],
  actions: { label: string; primary?: boolean; disabled?: boolean; run: () => void }[],
  closable = true,
): void {
  const close = () => root.replaceChildren();
  const box = el(
    "div",
    { class: "menu" },
    el("div", { class: "menu-title" }, title),
    ...lines.map((l) => el("div", { class: "menu-line" }, l)),
    el(
      "div",
      { class: "menu-actions" },
      ...actions.map((a) => {
        const b = el("button", { class: a.primary ? "primary" : "", onclick: () => (close(), a.run()) }, a.label) as HTMLButtonElement;
        b.disabled = a.disabled ?? false;
        return b;
      }),
      ...(closable ? [el("button", { class: "link", onclick: close }, "Закрыть")] : []),
    ),
  );
  root.replaceChildren(box);
}
