import { ApiError, type Api } from "../net/api.js";
import { el } from "../ui/dom.js";

// "Сообщить о проблеме": for the friends' run and the pilot, a tester writes what went wrong
// right where it happened. The gateway keeps it with the page and the phone's browser.

export interface FeedbackDeps {
  api: Api;
  token: () => string | undefined;
  /** The current page and the one before it: a report sent from Today is usually about the game. */
  page: () => string;
}

export function feedbackBox(d: FeedbackDeps): HTMLElement {
  const open = el("button", { type: "button", class: "link", "data-feedback-open": "" }, "Сообщить о проблеме") as HTMLButtonElement;
  const text = el("textarea", { class: "answer", rows: "4", maxlength: "4000", name: "feedback", placeholder: "Что случилось? Что вы нажали перед этим?", "aria-label": "Что случилось" }) as HTMLTextAreaElement;
  const send = el("button", { type: "button", class: "primary", "data-feedback-send": "" }, "Отправить") as HTMLButtonElement;
  const status = el("p", { class: "muted", role: "status" });
  const form = el("div", { class: "feedback-form", hidden: "" }, text, send, status);
  open.addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) text.focus();
  });
  send.addEventListener("click", async () => {
    const message = text.value.trim();
    const token = d.token();
    if (!message) return void (status.textContent = "Напишите пару слов о том, что случилось.");
    if (!token) return void (status.textContent = "Нет связи с сервером. Попробуйте позже или напишите преподавателю.");
    send.disabled = true;
    try {
      await d.api.sendFeedback(token, message, d.page());
      text.value = "";
      form.hidden = true;
      status.textContent = "";
      open.textContent = "Спасибо, отправлено. Сообщить ещё";
      open.dataset.sent = "";
    } catch (e) {
      status.textContent = e instanceof ApiError && e.userMessage ? e.userMessage : "Не отправилось. Проверьте интернет и попробуйте ещё раз.";
    } finally {
      send.disabled = false;
    }
  });
  return el("div", { class: "feedback" }, open, form);
}
