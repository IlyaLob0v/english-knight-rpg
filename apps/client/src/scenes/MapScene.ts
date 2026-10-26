import Phaser from "phaser";
import type { StepStatus, StepView } from "../game/progress.js";
import { playStory, showMenu } from "../ui/dialog.js";
import { services } from "./services.js";

const STATUS_COLOR: Record<StepStatus, number> = { locked: 0x4b4f5c, open: 0x3a7bd5, boss_ready: 0xd58a3a, cleared: 0x4caf6a };
const STATUS_LABEL: Record<StepStatus, string> = { locked: "закрыто", open: "в пути", boss_ready: "босс ждёт", cleared: "освобождено" };

/** The world map: one node per track step, in track order. Click a node to fight there. */
export class MapScene extends Phaser.Scene {
  constructor() {
    super("map");
  }

  create(): void {
    const { game, ui } = services(this);
    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor(0x1d2a1f);
    this.add.text(width / 2, 36, game.track.title.en, { fontFamily: "Georgia, serif", fontSize: "30px", color: "#f3e7c4" }).setOrigin(0.5);
    this.add.text(width / 2, 70, game.track.title.ru, { fontFamily: "Georgia, serif", fontSize: "16px", color: "#c9bb94" }).setOrigin(0.5);

    const steps = game.steps();
    const points = steps.map((_, i) => ({
      x: (width * (i + 1)) / (steps.length + 1),
      y: height / 2 + (i % 2 === 0 ? 40 : -40),
    }));

    const road = this.add.graphics();
    road.lineStyle(10, 0x6b5a3a, 1);
    for (let i = 1; i < points.length; i++) road.lineBetween(points[i - 1]!.x, points[i - 1]!.y, points[i]!.x, points[i]!.y);

    steps.forEach((s, i) => this.drawNode(s, points[i]!.x, points[i]!.y, ui));

    const sync = this.add.text(16, height - 28, "", { fontFamily: "system-ui, sans-serif", fontSize: "13px", color: "#9fb59f" });
    const refresh = async () => {
      const r = await game.sync();
      sync.setText(r.pendingStatements || r.pendingResults ? `Ждут отправки: ${r.pendingStatements} записей xAPI, ${r.pendingResults} оценок` : "Прогресс синхронизирован");
    };
    void refresh();
    const timer = this.time.addEvent({ delay: 15_000, loop: true, callback: () => void refresh() });
    this.events.once("shutdown", () => timer.remove());
  }

  private drawNode(s: StepView, x: number, y: number, ui: HTMLElement): void {
    const color = STATUS_COLOR[s.status];
    const node = this.add.circle(x, y, 44, color).setStrokeStyle(4, 0xf3e7c4);
    this.add.text(x, y, String(s.index + 1), { fontFamily: "Georgia, serif", fontSize: "34px", color: "#ffffff" }).setOrigin(0.5);
    this.add.text(x, y + 64, s.module.title.en, { fontFamily: "Georgia, serif", fontSize: "18px", color: "#f3e7c4" }).setOrigin(0.5);
    this.add.text(x, y + 88, `${s.module.cefr_level} · ${s.module.grammar_topic ?? s.module.skill} · ${STATUS_LABEL[s.status]}`, { fontFamily: "system-ui, sans-serif", fontSize: "13px", color: "#c9bb94" }).setOrigin(0.5);
    if (s.status === "locked") return;

    node.setInteractive({ useHandCursor: true }).on("pointerdown", () => void this.openStep(s, ui));
  }

  private async openStep(s: StepView, ui: HTMLElement): Promise<void> {
    const { game } = services(this);
    const intro = await game.storyOnce(s.step.intro);
    if (intro) await playStory(ui, intro);

    const lines = [s.module.title.ru];
    if (s.winsNeeded > 0 && s.status !== "cleared") lines.push(`Победы: ${Math.min(s.wins, s.winsNeeded)} из ${s.winsNeeded}, потом откроется босс`);
    if (s.status === "cleared") lines.push(`Лучший результат босса: ${Math.round((game.progress.modules[s.module.module_id]?.bestScore ?? 0) * 100)}%`);
    const pass = Math.round(s.module.mastery.pass_score * 100);
    showMenu(ui, s.module.title.en, lines, [
      ...(s.encounterEnemies.length ? [{ label: "В бой", primary: s.status === "open", run: () => this.scene.start("battle", { step: s.index, kind: "encounter" }) }] : []),
      {
        label: `Босс: ${s.boss.name.ru} (нужно ${pass}%)`,
        primary: s.status === "boss_ready",
        disabled: s.status === "open",
        run: () => this.scene.start("battle", { step: s.index, kind: "boss" }),
      },
      ...(s.step.intro && game.story(s.step.intro) ? [{ label: "Сюжет", run: () => void playStory(ui, game.story(s.step.intro)!) }] : []),
    ]);
  }
}
