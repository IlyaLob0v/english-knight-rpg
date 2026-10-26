import type { Building } from "@knight/content";
import Phaser from "phaser";
import type { BuildingState, BuildingView } from "../game/city.js";
import { showMenu } from "../ui/dialog.js";
import { showStats } from "../ui/stats.js";
import { drawHud, textButton } from "./hud.js";
import { services } from "./services.js";

/** Placeholder art: one colour per plot until sprites from the content are drawn. */
const WALLS = [0x9a6b3f, 0x7f8c99, 0x6b7f4a, 0x8c5f7a, 0x5f7a8c];
const STATE_LABEL: Record<BuildingState, string> = { locked: "руины", site: "можно строить", built: "стоит", damaged: "нужен ремонт" };

export function bonusLabel(b: Building["bonus"]): string {
  if (!b) return "без бонуса";
  if (b.kind === "max_hp") return `+${b.value} к здоровью рыцаря`;
  if (b.kind === "hint_charges") return `+${b.value} подсказки в бою`;
  if (b.kind === "xp_multiplier") return `+${Math.round((b.value - 1) * 100)}% XP`;
  return `+${Math.round((b.value - 1) * 100)}% KP`;
}

/**
 * The city: one plot per track step. A boss victory opens the plot for building,
 * KP pay for it, and a building whose module is fading shows cracks and loses its
 * bonus until it is repaired by review. Also the start of the daily patrol and the
 * statistics screen.
 */
export class CityScene extends Phaser.Scene {
  constructor() {
    super("city");
  }

  create(): void {
    const { game, ui } = services(this);
    this.cameras.main.setBackgroundColor(0x24301f);
    void game.checkRepairs().then((r) => {
      this.draw();
      if (r.repaired.length) {
        showMenu(ui, "Город отремонтирован", [`${r.repaired.map((b) => b.name.ru).join(", ")}: снова целы. +${r.earned.xp} XP, +${r.earned.kp} KP`], []);
      }
    });
  }

  private draw(): void {
    const { game, ui } = services(this);
    const { width, height } = this.scale;
    drawHud(this, game);
    this.add.text(width / 2, 30, "Город", { fontFamily: "Georgia, serif", fontSize: "30px", color: "#f3e7c4" }).setOrigin(0.5);
    this.add.text(width / 2, 62, game.track.title.ru, { fontFamily: "Georgia, serif", fontSize: "15px", color: "#c9bb94" }).setOrigin(0.5);

    // Ground and the road through the city.
    this.add.rectangle(width / 2, 360, width - 60, 250, 0x2f3d27).setStrokeStyle(2, 0x4a5a3a);
    this.add.rectangle(width / 2, 430, width - 60, 26, 0x6b5a3a);

    const views = game.city();
    views.forEach((v, i) => this.drawPlot(v, (width * (i + 1)) / (views.length + 1), 330, WALLS[i % WALLS.length]!));

    const patrol = game.patrolStatus();
    const patrolLine = !patrol.studiedConcepts
      ? "Патруль откроется, когда рыцарь потренируется в бою."
      : patrol.doneToday
        ? `Сегодняшний патруль пройден. Дней на этой неделе: ${patrol.daysThisWeek} из 7, серия: ${patrol.streak}.`
        : patrol.dueConcepts
          ? `Пора на патруль: просрочено концептов ${patrol.dueConcepts} из ${patrol.studiedConcepts}. Дней на этой неделе: ${patrol.daysThisWeek} из 7.`
          : `Патруль ждёт: просроченных концептов нет, повторим самые слабые. Дней на этой неделе: ${patrol.daysThisWeek} из 7.`;
    this.add.text(width / 2, height - 92, patrolLine, { fontFamily: "system-ui, sans-serif", fontSize: "14px", color: "#c9bb94" }).setOrigin(0.5);

    const y = height - 48;
    textButton(this, width / 2 - 230, y, patrol.doneToday ? "Ещё патруль" : "Дневной патруль", () => this.scene.start("battle", { kind: "patrol" }), {
      primary: !patrol.doneToday && patrol.studiedConcepts > 0,
      disabled: patrol.studiedConcepts === 0,
    });
    textButton(this, width / 2, y, "Статистика ошибок", () => void showStats(ui, (days) => game.errorReport(days), game.rules.repair.threshold));
    textButton(this, width / 2 + 230, y, "Карта похода", () => this.scene.start("map"), { primary: patrol.studiedConcepts === 0 });
  }

  private drawPlot(v: BuildingView, x: number, y: number, wall: number): void {
    const g = this.add.graphics();
    const w = 150;
    const h = 100;
    const top = y - h / 2;
    if (v.state === "locked") {
      g.fillStyle(0x4b4f5c, 1);
      for (const [dx, dy, rw, rh] of [[-60, 30, 40, 20], [-10, 20, 30, 30], [30, 35, 45, 15], [-35, 0, 20, 25]] as const) g.fillRect(x + dx, y + dy, rw, rh);
    } else if (v.state === "site") {
      g.lineStyle(4, 0xb08a4a, 1);
      g.strokeRect(x - w / 2, top, w, h);
      for (let i = 1; i < 4; i++) g.lineBetween(x - w / 2 + (w * i) / 4, top, x - w / 2 + (w * i) / 4, top + h);
      g.lineBetween(x - w / 2, top + h / 2, x + w / 2, top + h / 2);
      g.lineBetween(x - w / 2, top, x + w / 2, top + h);
    } else {
      const damaged = v.state === "damaged";
      const color = damaged ? Phaser.Display.Color.ValueToColor(wall).darken(35).color : wall;
      g.fillStyle(color, 1).fillRect(x - w / 2, top, w, h);
      g.fillStyle(damaged ? 0x4a3020 : 0x8c2f2f, 1).fillTriangle(x - w / 2 - 12, top, x + w / 2 + 12, top, x, top - 60);
      g.fillStyle(0x2b1d10, 1).fillRect(x - 15, top + h - 46, 30, 46);
      g.fillStyle(0xf3d98a, damaged ? 0.25 : 1).fillRect(x - 55, top + 20, 22, 22).fillRect(x + 33, top + 20, 22, 22);
      if (damaged) {
        g.lineStyle(3, 0xd5553a, 1);
        g.lineBetween(x - 40, top + 5, x - 20, top + 40).lineBetween(x - 20, top + 40, x - 35, top + 70);
        g.lineBetween(x + 45, top - 10, x + 25, top + 30).lineBetween(x + 25, top + 30, x + 50, top + 60);
      }
    }

    const nameColor = v.state === "locked" ? "#8a8f9c" : "#f3e7c4";
    this.add.text(x, y + 75, v.building.name.ru, { fontFamily: "Georgia, serif", fontSize: "19px", color: nameColor }).setOrigin(0.5);
    const sub =
      v.state === "site" ? `стройка: ${v.building.cost_kp} KP` : v.state === "built" ? bonusLabel(v.building.bonus) : STATE_LABEL[v.state];
    const subColor = v.state === "damaged" ? "#d5553a" : v.state === "site" && v.affordable ? "#d58a3a" : "#c9bb94";
    this.add.text(x, y + 99, sub, { fontFamily: "system-ui, sans-serif", fontSize: "13px", color: subColor }).setOrigin(0.5);

    const hit = this.add.zone(x, y + 10, w + 40, h + 150).setInteractive({ useHandCursor: true });
    hit.on("pointerdown", () => this.openPlot(v));
  }

  private openPlot(v: BuildingView): void {
    const { game, ui } = services(this);
    const lines = [`Модуль: ${v.module.title.ru} (${v.module.cefr_level})`, `Бонус: ${bonusLabel(v.building.bonus)}`];
    if (v.state === "locked") lines.push("Победи босса этого модуля на карте, чтобы открыть стройку.");
    if (v.state === "site") lines.push(`Стоимость: ${v.building.cost_kp} KP, у тебя ${game.progress.kp} KP.`);
    if (v.state === "damaged") lines.push("Концепты модуля забываются, здание треснуло и не даёт бонус. Повтори их, чтобы отремонтировать.");
    if (v.state === "built" || v.state === "damaged") {
      const threshold = Math.round(game.rules.repair.threshold * 100);
      lines.push(`Вероятность вспомнить (ремонт нужен ниже ${threshold}%):`);
      for (const c of v.concepts) {
        lines.push(`• ${c.concept.label}: ${c.retrievability === undefined ? "ещё не тренировался" : `${Math.round(c.retrievability * 100)}%`}${c.weak ? " — трещина" : ""}`);
      }
    }
    const actions = [];
    if (v.state === "site") {
      actions.push({
        label: `Построить за ${v.building.cost_kp} KP`,
        primary: true,
        disabled: !v.affordable,
        run: () => void game.build(v.building.building_id).then(() => this.scene.restart()),
      });
    }
    if (v.state === "damaged") {
      actions.push({ label: "Ремонт", primary: true, run: () => this.scene.start("battle", { kind: "repair", building: v.building.building_id }) });
    }
    showMenu(ui, v.building.name.ru, lines, actions);
  }
}
