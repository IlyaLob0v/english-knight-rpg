import { ApiError, type Api, type Dashboard, type GroupView, type HomeworkView, type SlotView } from "../net/api.js";
import type { KeyValue } from "../storage/idb.js";
import { el } from "../ui/dom.js";
import { fileSize, loadDashboard, scheduleText, when } from "./school.js";

// The teacher's cabinet, first version: groups with their schedule and call link, the
// invitation link, homework for the group and the files students handed in. Grading and
// comments on the files come with the review queue.

export interface TeacherDeps {
  api: Api;
  token: string | undefined;
  kv: KeyValue;
  now?: Date;
}

const MSK_MS = 3 * 3600_000;
const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/** "2026-12-03T18:00" typed in Moscow time → ISO. */
export function moscowInputToIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - MSK_MS).toISOString();
}

function messageOf(e: unknown): string {
  return e instanceof ApiError && e.userMessage ? e.userMessage : "Не получилось. Проверьте интернет и попробуйте ещё раз.";
}

export async function renderTeacher(root: HTMLElement, d: TeacherDeps): Promise<void> {
  const dash = await loadDashboard(d.api, d.token, d.kv);
  const now = d.now ?? new Date();
  const rerender = () => void renderTeacher(root, d);
  const groups = dash?.groups ?? [];
  root.replaceChildren(
    el(
      "div",
      { class: "teacher" },
      el("header", { class: "section-head" }, el("a", { href: "/", "data-link": "", class: "back" }, "← Сегодня"), el("h1", {}, "Кабинет преподавателя")),
      ...(d.token ? [] : [el("p", { class: "form-error" }, "Нет связи с сервером: показано то, что было при последнем входе.")]),
      ...groups.map((g) => groupCard(g, dash!, now, d, rerender)),
      newGroupForm(d, rerender, groups.length === 0),
    ),
  );
}

function groupCard(g: GroupView, dash: Dashboard, now: Date, d: TeacherDeps, rerender: () => void): HTMLElement {
  const members = g.members ?? [];
  const inviteBox = el("div", { class: "invite" });
  const inviteButton = el("button", { type: "button", "data-invite": g.group_id }, "Пригласить ученика") as HTMLButtonElement;
  inviteButton.addEventListener("click", async () => {
    if (!d.token) return;
    inviteButton.disabled = true;
    try {
      const inv = await d.api.createInvite(d.token, g.group_id);
      const field = el("input", { class: "answer invite-url", readonly: "", value: inv.url, "aria-label": "Ссылка-приглашение" }) as HTMLInputElement;
      const copy = el("button", { type: "button" }, "Скопировать") as HTMLButtonElement;
      copy.addEventListener("click", () => {
        field.select();
        void navigator.clipboard?.writeText(inv.url).then(() => (copy.textContent = "Скопировано"));
      });
      inviteBox.replaceChildren(
        field,
        copy,
        el("p", { class: "muted" }, `Ссылка действует до ${when(new Date(inv.expires_at), new Date())}. По ней ученик сам заводит логин и пароль.`),
      );
    } catch (e) {
      inviteBox.replaceChildren(el("p", { class: "form-error" }, messageOf(e)));
    } finally {
      inviteButton.disabled = false;
    }
  });

  const homework = dash.homework.filter((h) => h.group_id === g.group_id);
  return el(
    "section",
    { class: "card group", "data-group": g.group_id },
    el("h2", {}, g.name),
    el("p", { class: "muted" }, scheduleText(g.schedule)),
    ...(g.call_url ? [el("p", { class: "muted" }, "Звонок: ", el("a", { href: g.call_url, target: "_blank", rel: "noopener" }, g.call_url))] : []),
    el("p", { "data-members": String(members.length) }, members.length ? `Ученики (${members.length}): ${members.map((m) => m.name).join(", ")}` : "Учеников пока нет"),
    inviteButton,
    inviteBox,
    el("h3", {}, "Домашка"),
    ...(homework.length ? homework.map((h) => homeworkItem(h, members.length, now, d)) : [el("p", { class: "muted" }, "Ещё ничего не задано.")]),
    newHomeworkForm(g, d, rerender),
  );
}

function homeworkItem(h: HomeworkView, members: number, now: Date, d: TeacherDeps): HTMLElement {
  const subs = h.submissions ?? [];
  return el(
    "div",
    { class: "hw-item", "data-homework": h.homework_id },
    el("p", { class: "hw-title" }, h.title),
    el("p", { class: "muted" }, [h.due_at ? `до ${when(new Date(h.due_at), now)}` : "без срока", h.needs_file ? `сдали ${subs.length} из ${members}` : "без файла"].join(" · ")),
    ...subs.map((s) => {
      const open = el("button", { type: "button", class: "link", "data-submission": s.submission_id }, `${s.student_name}: ${s.file_name} (${fileSize(s.size)})`) as HTMLButtonElement;
      open.addEventListener("click", async () => {
        if (!d.token) return;
        try {
          // The server names the file (Content-Disposition), so it keeps its Cyrillic name everywhere.
          location.assign(await d.api.submissionLink(d.token, s.submission_id));
        } catch (e) {
          open.textContent = messageOf(e);
        }
      });
      return open;
    }),
  );
}

function newHomeworkForm(g: GroupView, d: TeacherDeps, rerender: () => void): HTMLElement {
  const title = el("input", { class: "answer", name: "title", maxlength: "120", required: "", "aria-label": "Название" }) as HTMLInputElement;
  const description = el("textarea", { class: "answer", name: "description", rows: "3", maxlength: "4000", "aria-label": "Что сделать" }) as HTMLTextAreaElement;
  const due = el("input", { class: "answer", type: "datetime-local", name: "due", "aria-label": "Срок" }) as HTMLInputElement;
  const needsFile = el("input", { type: "checkbox", name: "needs_file", checked: "" }) as HTMLInputElement;
  const error = el("p", { class: "form-error", role: "alert" });
  const form = el(
    "form",
    {
      class: "hw-form",
      "data-form": "homework",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!d.token) return;
        try {
          await d.api.createHomework(d.token, g.group_id, {
            title: title.value.trim(),
            description: description.value.trim(),
            due_at: due.value ? moscowInputToIso(due.value) : null,
            needs_file: needsFile.checked,
          });
          rerender();
        } catch (err) {
          error.textContent = messageOf(err);
        }
      },
    },
    el("label", {}, "Название", title),
    el("label", {}, "Что сделать", description),
    el("label", {}, "Срок (по Москве)", due),
    el("label", { class: "check" }, needsFile, "Сдаётся файлом: запись, фото или документ"),
    error,
    el("button", { class: "primary", type: "submit" }, "Задать"),
  );
  return el("details", { class: "new-homework" }, el("summary", {}, "Новая домашка"), form);
}

function newGroupForm(d: TeacherDeps, rerender: () => void, open: boolean): HTMLElement {
  const name = el("input", { class: "answer", name: "name", maxlength: "80", required: "", "aria-label": "Название группы" }) as HTMLInputElement;
  const call = el("input", { class: "answer", type: "url", name: "call_url", placeholder: "https://telemost.yandex.ru/…", "aria-label": "Ссылка на звонок" }) as HTMLInputElement;
  const days = DAYS.map((label, i) => ({ day: i + 1, box: el("input", { type: "checkbox", name: `day${i + 1}`, "aria-label": label }) as HTMLInputElement, label }));
  const time = el("input", { class: "answer", type: "time", name: "time", value: "18:30", "aria-label": "Время" }) as HTMLInputElement;
  const minutes = el("input", { class: "answer", type: "number", name: "minutes", value: "60", min: "15", max: "240", step: "5", "aria-label": "Минут" }) as HTMLInputElement;
  const error = el("p", { class: "form-error", role: "alert" });
  const form = el(
    "form",
    {
      class: "card group-form",
      "data-form": "group",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!d.token) return;
        const schedule: SlotView[] = days.filter((x) => x.box.checked).map((x) => ({ weekday: x.day, time: time.value, minutes: Number(minutes.value) }));
        try {
          await d.api.createGroup(d.token, { name: name.value.trim(), call_url: call.value.trim() || null, schedule });
          rerender();
        } catch (err) {
          error.textContent = messageOf(err);
        }
      },
    },
    el("h2", {}, open ? "Первая группа" : "Новая группа"),
    el("label", {}, "Название", name),
    el("label", {}, "Ссылка на звонок", call),
    el("fieldset", { class: "days" }, el("legend", {}, "Дни занятий"), ...days.map((x) => el("label", { class: "day" }, x.box, x.label))),
    el("div", { class: "row" }, el("label", {}, "Время (по Москве)", time), el("label", {}, "Минут", minutes)),
    error,
    el("button", { class: "primary", type: "submit" }, "Создать группу"),
  );
  return form;
}
