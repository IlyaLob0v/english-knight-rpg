import { describe, expect, it } from "vitest";
import { RepeatSchedule } from "../src/index.js";

// Moscow time: 2026-11-09 12:00 is day 0 of these tests.
const at = (day: number, hour = 12) => new Date(Date.UTC(2026, 10, 9 + day, hour - 3));
const wrong = { conceptId: "to_be.i_am", correct: false, taskId: "A1_NiceToMeetYou_01_i_am", errorType: "grammar.agreement" };
const right = { ...wrong, correct: true };
const dueIds = (s: RepeatSchedule, day: number, hour?: number) => s.due(at(day, hour)).map((i) => i.concept_id);

describe("RepeatSchedule (1/3/7)", () => {
  it("brings an error of day 0 back on days 1, 3 and 7, then retires it", () => {
    const s = new RepeatSchedule();
    expect(s.record(wrong, at(0))).toBe("started");
    const seen: number[] = [];
    for (let day = 0; day <= 10; day++) {
      if (dueIds(s, day).length) {
        seen.push(day);
        s.record(right, at(day));
      }
    }
    expect(seen).toEqual([1, 3, 7]);
    expect(s.toJSON()).toEqual([]);
  });

  it("keeps the item and its error for the lost-and-found", () => {
    const s = new RepeatSchedule();
    s.record(wrong, at(0));
    expect(s.due(at(1))).toEqual([{ concept_id: "to_be.i_am", origin_day: s.day(at(0)), step: 0, task_id: wrong.taskId, error_type: "grammar.agreement" }]);
  });

  it("does not count a correct answer before the due day", () => {
    const s = new RepeatSchedule();
    s.record(wrong, at(0));
    expect(s.record(right, at(0, 18))).toBe("none");
    expect(s.get("to_be.i_am")!.step).toBe(0);
    expect(dueIds(s, 1)).toEqual(["to_be.i_am"]);
  });

  it("restarts the cycle from the day of a new error", () => {
    const s = new RepeatSchedule();
    s.record(wrong, at(0));
    s.record(right, at(1));
    expect(s.record(wrong, at(3))).toBe("restarted");
    expect(dueIds(s, 3)).toEqual([]);
    expect(dueIds(s, 4)).toEqual(["to_be.i_am"]);
    expect(s.get("to_be.i_am")!.step).toBe(0);
  });

  it("keeps an overdue item due after a missed day, and the next review counts from the error", () => {
    const s = new RepeatSchedule();
    s.record(wrong, at(0));
    expect(dueIds(s, 2)).toEqual(["to_be.i_am"]);
    expect(s.record(right, at(2))).toBe("advanced");
    expect(dueIds(s, 2)).toEqual([]);
    expect(dueIds(s, 3)).toEqual(["to_be.i_am"]);
  });

  it("uses school days, not 24 hours: an error at 23:50 is due the next morning", () => {
    const s = new RepeatSchedule();
    s.record(wrong, new Date(Date.UTC(2026, 10, 9, 20, 50))); // 23:50 Moscow
    expect(s.due(new Date(Date.UTC(2026, 10, 9, 20, 59)))).toEqual([]);
    expect(s.due(new Date(Date.UTC(2026, 10, 9, 21, 1)))).toHaveLength(1); // 00:01 Moscow
  });

  it("orders the longest overdue first and survives a JSON round trip", () => {
    const s = new RepeatSchedule();
    s.record({ ...wrong, conceptId: "b.later" }, at(1));
    s.record({ ...wrong, conceptId: "a.earlier" }, at(0));
    s.record({ ...wrong, conceptId: "c.today" }, at(5));
    const restored = new RepeatSchedule({}, JSON.parse(JSON.stringify(s.toJSON())));
    expect(dueIds(restored, 5)).toEqual(["a.earlier", "b.later"]);
  });

  it("takes other intervals and rejects nonsense", () => {
    const s = new RepeatSchedule({ intervals: [2, 5] });
    s.record(wrong, at(0));
    expect(dueIds(s, 1)).toEqual([]);
    s.record(right, at(2));
    expect(s.record(right, at(5))).toBe("retired");
    expect(() => new RepeatSchedule({ intervals: [3, 1] })).toThrow();
    expect(() => new RepeatSchedule({ intervals: [] })).toThrow();
  });
});
