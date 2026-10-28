import { el } from "../ui/dom.js";
import type { Profile } from "./today.js";

const KEY = "moonbridge.profile";

export function loadProfile(): Profile | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Profile>) : undefined;
    return typeof p?.name === "string" && p.name.trim() ? { name: p.name.trim() } : undefined;
  } catch {
    return undefined;
  }
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Private mode: the name lives for this page only.
  }
}

/**
 * Sign-in. Until invitations arrive (week 5) the student only gives a name and gets a
 * device session; the same session then opens every section of the platform.
 */
export function askProfile(root: HTMLElement): Promise<Profile> {
  return new Promise((resolve) => {
    const input = el("input", { type: "text", class: "answer", name: "name", autocomplete: "given-name", maxlength: "40", "aria-label": "Имя" }) as HTMLInputElement;
    const form = el(
      "form",
      {
        class: "card login",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const name = input.value.trim();
          if (name) resolve({ name });
        },
      },
      el("div", { class: "brand" }, "Школа английского"),
      el("h1", {}, "Вход"),
      el("label", {}, "Как вас зовут?", input),
      el("button", { class: "primary", type: "submit" }, "Войти"),
    );
    root.replaceChildren(form);
    input.focus();
  });
}
