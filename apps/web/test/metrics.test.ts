import { describe, expect, it } from "vitest";
import type { GroupMetrics } from "../src/net/api.js";
import { weeksCsv } from "../src/platform/metrics.js";

const week = { from: "2026-11-30", to: "2026-12-06", complete: true, active: 2, avgDays: 3.5, medianSessionMinutes: 9, voluntaryStudents: 1, lostOffered: 4, lostReturned: 3 };
const none = { value: null, target: 0, status: "no_data" as const };

describe("the metrics snapshot", () => {
  it("writes one CSV line per week with Russian decimals and an empty cell for a missing median", () => {
    const g: GroupMetrics = {
      group: { id: "grp_1", name: "A1; вечер" },
      pilot_from: null,
      feedback: [],
      metrics: {
        from: "2026-11-30",
        weeks: [week, { ...week, from: "2026-12-07", to: "2026-12-13", complete: false, active: 0, avgDays: 0, medianSessionMinutes: null, voluntaryStudents: 0, lostOffered: 0, lostReturned: 0 }],
        students: [
          { id: "a", name: "Анна", days: [5, 0], sessions: 6, voluntary: 1, medianSessionMinutes: 9, lostOffered: 2, lostReturned: 2 },
          { id: "b", name: "Борис", days: [2, 0], sessions: 2, voluntary: 0, medianSessionMinutes: 20, lostOffered: 2, lostReturned: 1 },
        ],
        summary: {
          practiceDays: none,
          active: { ...none, week: null, students: 0, of: 2 },
          sessionMinutes: none,
          voluntaryShare: none,
          lostReturned: { ...none, returned: 0, offered: 0 },
          errorTypes: { improved: 0, compared: 0, trends: [] },
        },
      },
    };
    expect(weeksCsv(g).split("\n")).toEqual([
      "неделя;с;по;учеников;активны;дней в среднем;медиана сессии, мин;с добровольными сессиями;бюро: предложено;бюро: возвращено",
      "1;2026-11-30;2026-12-06;2;2;3,5;9;1;4;3",
      "2;2026-12-07;2026-12-13;2;0;0;;0;0;0",
      "",
    ]);
  });
});
