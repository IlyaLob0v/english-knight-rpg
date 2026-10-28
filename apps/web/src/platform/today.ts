import type { Learner } from "../core/learner.js";
import { streakOf, todaysShift } from "../moonbridge/daily.js";
import { hotelView, migrateState, studentCourse } from "../moonbridge/progress.js";
import type { KeyValue } from "../storage/idb.js";
import { el } from "../ui/dom.js";

export interface Profile {
  name: string;
}

/** The platform's home screen: what to do today, across courses and sections. */
export async function renderToday(root: HTMLElement, d: { profile: Profile; learner: Learner; kv: KeyValue; now?: Date }): Promise<void> {
  const now = d.now ?? new Date();
  const bundle = d.learner.bundle;
  const course = studentCourse(bundle);
  const due = d.learner.repeats.due(now);
  const cards: HTMLElement[] = [];

  if (bundle.moonbridge && course) {
    const state = migrateState(await d.kv.get("moonbridge"));
    const view = hotelView(bundle.moonbridge, course, state);
    const day = d.learner.day(now);
    const shift = await todaysShift(d.learner, state);
    const shiftOpen = shift && !state.shift_days.includes(day) && (shift.lostAndFound.length > 0 || shift.guest);
    const streak = streakOf(state.practice_days, day).days;
    cards.push(
      el(
        "a",
        { class: "card section-card moonbridge", href: "/moonbridge", "data-link": "", "data-section": "moonbridge" },
        el("h2", {}, "Moonbridge"),
        el("p", {}, view.next ? `Hotel Hello ждёт: ${view.next.title.ru}` : "Все эпизоды пройдены, загляните в отель."),
        ...(shiftOpen ? [el("p", { "data-today-shift": "" }, `Смена в отеле: ${shift.lostAndFound.length ? `вещей в бюро находок: ${shift.lostAndFound.length}` : ""}${shift.lostAndFound.length && shift.guest ? ", " : ""}${shift.guest ? `гость дня ${shift.guest.template.name}` : ""}.`)] : []),
        ...(streak ? [el("p", { class: "muted" }, `Дней практики подряд: ${streak}`)] : []),
        el("span", { class: "card-action" }, "Открыть →"),
      ),
    );
  }
  cards.push(
    el(
      "div",
      { class: "card", "data-card": "repeats" },
      el("h2", {}, "Повторение"),
      el("p", {}, due.length ? `Сегодня вернутся ${due.length} ${plural(due.length, "тема", "темы", "тем")} с ошибками.` : "Сегодня повторять нечего."),
    ),
    el("div", { class: "card muted-card" }, el("h2", {}, "Расписание и домашка"), el("p", { class: "muted" }, "Появятся, когда преподаватель добавит вас в группу.")),
  );

  root.replaceChildren(
    el(
      "div",
      { class: "today" },
      el("header", { class: "platform-head" }, el("div", { class: "brand" }, "Школа английского"), el("h1", {}, `${greeting(now)}, ${d.profile.name}`)),
      el("h2", { class: "today-title" }, "Сегодня"),
      ...cards,
    ),
  );
}

function greeting(at: Date): string {
  const h = (at.getUTCHours() + 3) % 24; // Moscow
  if (h < 5) return "Доброй ночи";
  if (h < 12) return "Доброе утро";
  if (h < 18) return "Добрый день";
  return "Добрый вечер";
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
