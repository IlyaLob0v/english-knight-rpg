import type { ContentBundle } from "@knight/content";
import { beforeAll, describe, expect, it } from "vitest";
import { emptyProgress, recordBossResult, recordEncounterWin, trackView } from "../src/game/progress.js";
import { loadBundle } from "./fixtures.js";

let bundle: ContentBundle;
beforeAll(async () => {
  bundle = await loadBundle();
});

describe("trackView", () => {
  it("opens the first step, locks the rest, and unlocks the boss after enough wins", () => {
    const track = bundle.tracks[0]!;
    let p = emptyProgress();
    expect(trackView(bundle, track, p).map((s) => s.status)).toEqual(["open", "locked", "locked"]);
    const first = trackView(bundle, track, p)[0]!;
    for (let i = 0; i < first.winsNeeded; i++) p = recordEncounterWin(p, first.module.module_id);
    expect(trackView(bundle, track, p)[0]!.status).toBe("boss_ready");
    p = recordBossResult(p, first.module.module_id, { passed: false, scaled: 0.5 });
    expect(trackView(bundle, track, p)[0]!.status).toBe("boss_ready");
    p = recordBossResult(p, first.module.module_id, { passed: true, scaled: 0.9 });
    expect(trackView(bundle, track, p).map((s) => s.status)).toEqual(["cleared", "open", "locked"]);
    expect(p.modules[first.module.module_id]).toMatchObject({ bestScore: 0.9, bossAttempts: 2, bossPassed: true });
  });

  it("takes order, bosses and enemies from the track, so reordering content reorders the map", () => {
    const track = structuredClone(bundle.tracks[0]!);
    const steps = track.chapters[0]!.steps;
    // Swap steps 2 and 3 (neither is a prerequisite of the other).
    [steps[1], steps[2]] = [steps[2]!, steps[1]!];
    let p = emptyProgress();
    p = recordBossResult(p, "A1_VerbToBe_01", { passed: true, scaled: 1 });
    const view = trackView(bundle, track, p);
    expect(view.map((s) => s.module.module_id)).toEqual(["A1_VerbToBe_01", "A1_Articles_01", "A1_PastSimple_01"]);
    expect(view[1]!.status).toBe("open");
    expect(view[1]!.boss.enemy_id).toBe("silent_scribe");
    expect(view[1]!.encounterEnemies.map((e) => e.enemy_id)).toEqual(steps[1]!.encounters!.enemies);
  });

  it("a step without a boss or encounters still ends with a trial", () => {
    const track = structuredClone(bundle.tracks[0]!);
    const step = track.chapters[0]!.steps[0]!;
    delete step.boss;
    delete step.encounters;
    const view = trackView(bundle, track, emptyProgress())[0]!;
    expect(view.status).toBe("boss_ready");
    expect(view.boss.role).toBe("boss");
  });
});
