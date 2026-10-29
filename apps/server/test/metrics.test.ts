import { describe, expect, it } from "vitest";
import { median, pilotMetrics, sessionsOf, type MetricAttempt } from "../src/school/metrics.js";

// Monday 2026-11-30 00:00 Moscow.
const FROM = new Date("2026-11-29T21:00:00Z");
const msk = (day: string, time: string) => new Date(`${day}T${time}:00+03:00`);

function a(player: string, at: Date, o: Partial<MetricAttempt> = {}): MetricAttempt {
  return { playerId: player, answeredAt: at, taskId: "t1", success: true, errorType: null, attemptNo: 1, durationMs: 60_000, mode: null, ...o };
}

/** `count` answers a minute apart from `start`. */
function burst(player: string, start: Date, count: number, o: Partial<MetricAttempt> = {}): MetricAttempt[] {
  return Array.from({ length: count }, (_, i) => a(player, new Date(start.getTime() + i * 60_000), o));
}

const students = [
  { id: "acc_anna", name: "Анна", playerId: "p_anna" },
  { id: "acc_boris", name: "Борис", playerId: "p_boris" },
];

describe("sessions", () => {
  it("cuts answers into sessions at a 30-minute pause and at Moscow midnight; later ones that day are voluntary", () => {
    const s = sessionsOf([
      ...burst("p", msk("2026-11-30", "18:00"), 10), // 18:00–18:09, the first answer started at 17:59
      ...burst("p", msk("2026-11-30", "18:30"), 3), // a 21-minute pause: same session
      ...burst("p", msk("2026-11-30", "20:00"), 2), // a new, voluntary session
      a("p", msk("2026-11-30", "23:59")),
      a("p", msk("2026-12-01", "00:01")), // a new day: required again
    ]);
    expect(s.map((x) => [x.day, x.minutes, x.voluntary])).toEqual([
      ["2026-11-30", 33, false],
      ["2026-11-30", 2, true],
      ["2026-11-30", 1, true],
      ["2026-12-01", 1, false],
    ]);
  });

  it("takes the median of an even list as the mean of the middle two", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("pilot metrics", () => {
  it("counts days, active students, sessions, voluntary practice and the lost-and-found by week", () => {
    const attempts = [
      // Week 1: Anna practises 5 days, 9 minutes each; once she comes back in the evening.
      ...["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"].flatMap((d) => burst("p_anna", msk(d, "18:00"), 9)),
      ...burst("p_anna", msk("2026-12-02", "21:00"), 3),
      // Boris: 2 days, 19 minutes each.
      ...burst("p_boris", msk("2026-12-01", "08:00"), 19),
      ...burst("p_boris", msk("2026-12-05", "08:00"), 19),
      // The lost-and-found: 3 of 4 things go back, a second try does not count.
      a("p_anna", msk("2026-12-01", "18:20"), { mode: "lost_and_found" }),
      a("p_anna", msk("2026-12-01", "18:21"), { mode: "lost_and_found" }),
      a("p_boris", msk("2026-12-05", "08:19"), { mode: "lost_and_found", success: false }),
      a("p_boris", msk("2026-12-05", "08:19"), { mode: "lost_and_found", attemptNo: 2 }),
      a("p_boris", msk("2026-12-05", "08:20"), { mode: "lost_and_found" }),
      // Week 2, still running: only Anna.
      ...burst("p_anna", msk("2026-12-07", "18:00"), 9),
      // Someone outside the group.
      ...burst("p_stranger", msk("2026-12-01", "10:00"), 5),
    ];
    const m = pilotMetrics({ students, attempts, from: FROM, now: msk("2026-12-08", "12:00"), taskErrorTypes: () => [] });

    expect(m.from).toBe("2026-11-30");
    expect(m.weeks).toHaveLength(2);
    expect(m.weeks[0]).toMatchObject({ from: "2026-11-30", to: "2026-12-06", complete: true, active: 2, avgDays: 3.5, voluntaryStudents: 1, lostOffered: 4, lostReturned: 3 });
    expect(m.weeks[1]).toMatchObject({ complete: false, active: 1, avgDays: 0.5 });

    // Averages use complete weeks only.
    expect(m.summary.practiceDays).toEqual({ value: 3.5, target: 4, status: "below" });
    expect(m.summary.active).toMatchObject({ value: 100, week: 1, students: 2, of: 2, status: "ok" });
    expect(m.summary.voluntaryShare).toEqual({ value: 50, target: 50, status: "ok" });
    expect(m.summary.lostReturned).toMatchObject({ value: 75, returned: 3, offered: 4, status: "ok" });
    // Required sessions: Anna's five of 9 minutes and one of 22 (with the lost-and-found), Boris's 19 and 21.
    expect(m.summary.sessionMinutes.value).toBe(9);
    expect(m.summary.sessionMinutes.status).toBe("ok");

    const anna = m.students.find((s) => s.id === "acc_anna")!;
    expect(anna).toMatchObject({ days: [5, 1], sessions: 7, voluntary: 1, lostOffered: 2, lostReturned: 2 });
  });

  it("reports the 4th week's active students once that week is over", () => {
    const weekly = (w: number) => burst("p_anna", new Date(msk("2026-11-30", "18:00").getTime() + w * 7 * 86_400_000), 3);
    const attempts = [0, 1, 2, 3].flatMap(weekly);
    const third = pilotMetrics({ students, attempts, from: FROM, now: msk("2026-12-21", "12:00"), taskErrorTypes: () => [] });
    expect(third.summary.active).toMatchObject({ week: 3, students: 1, of: 2, value: 50, status: "below" });
    const later = pilotMetrics({ students, attempts, from: FROM, now: msk("2027-01-11", "12:00"), taskErrorTypes: () => [] });
    expect(later.summary.active.week).toBe(4);
  });

  it("compares first-try accuracy by error type between the first and the last week with enough answers", () => {
    const types = (taskId: string) => (taskId === "articles" ? ["grammar.article"] : taskId === "be" ? ["grammar.agreement", "grammar.article"] : []);
    const week = (w: number, taskId: string, right: number, total: number) =>
      Array.from({ length: total }, (_, i) => a("p_anna", new Date(msk("2026-11-30", "18:00").getTime() + w * 7 * 86_400_000 + i * 60_000), { taskId, success: i < right }));
    const attempts = [
      ...week(0, "articles", 2, 5), // 40%
      ...week(1, "articles", 1, 3), // too few to count
      ...week(2, "articles", 4, 5), // 80%
      ...week(0, "be", 3, 4), // agreement: too few in week 1
      ...week(1, "be", 3, 5), // 60%
      ...week(2, "be", 2, 5), // 40%
      ...week(2, "other", 0, 9), // no error types: not compared
    ];
    const labels: Record<string, string> = { "grammar.article": "Артикли" };
    const m = pilotMetrics({ students, attempts, from: FROM, now: msk("2026-12-21", "12:00"), taskErrorTypes: types, errorLabel: (t) => labels[t] });
    expect(m.summary.errorTypes.compared).toBe(2);
    expect(m.summary.errorTypes.improved).toBe(1);
    expect(m.summary.errorTypes.trends).toEqual([
      // Articles: the be-tasks can produce it too, so week 1 is 5 of 9 and week 3 is 6 of 10.
      { errorType: "grammar.article", label: "Артикли", firstWeek: "2026-11-30", firstAccuracy: 56, lastWeek: "2026-12-14", lastAccuracy: 60, change: 4 },
      { errorType: "grammar.agreement", label: "grammar.agreement", firstWeek: "2026-12-07", firstAccuracy: 60, lastWeek: "2026-12-14", lastAccuracy: 40, change: -20 },
    ]);
  });

  it("says there is no data before anyone answers", () => {
    const m = pilotMetrics({ students, attempts: [], from: FROM, now: msk("2026-12-02", "12:00"), taskErrorTypes: () => [] });
    expect(m.weeks).toHaveLength(1);
    expect(Object.values(m.summary).filter((x) => "status" in x).map((x) => (x as { status: string }).status)).toEqual(["no_data", "no_data", "no_data", "no_data", "no_data"]);
  });
});

describe("accuracy by error type", () => {
  it("leaves out of the count the types already at 100% in their first week", () => {
    const at = (w: number, i: number) => new Date(msk("2026-11-30", "18:00").getTime() + w * 7 * 86_400_000 + i * 60_000);
    const attempts = [0, 1].flatMap((w) => Array.from({ length: 5 }, (_, i) => a("p_anna", at(w, i), { taskId: "easy" })));
    const m = pilotMetrics({ students, attempts, from: FROM, now: msk("2026-12-14", "12:00"), taskErrorTypes: () => ["grammar.article"] });
    expect(m.summary.errorTypes).toMatchObject({ improved: 0, compared: 0, trends: [{ firstAccuracy: 100, lastAccuracy: 100, change: 0 }] });
  });
});
