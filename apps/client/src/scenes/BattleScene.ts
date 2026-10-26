import Phaser from "phaser";
import type { Battle, BattleKind } from "../game/battle.js";
import type { BattleEnd } from "../game/game.js";
import { playStory, showMenu } from "../ui/dialog.js";
import { askTask, showFeedback } from "../ui/task-panel.js";
import { services } from "./services.js";

const ROLE_COLOR = { minion: 0x8c6d4f, elite: 0x6d4f8c, boss: 0x8c2f2f } as const;

interface Fighter {
  body: Phaser.GameObjects.Rectangle;
  bar: Phaser.GameObjects.Rectangle;
  hpText: Phaser.GameObjects.Text;
  barWidth: number;
}

/**
 * A turn-based battle: every turn is one task from the module's pool. A right
 * answer is the knight's strike, an error is the enemy's. The scene only draws;
 * Game and Battle decide.
 */
export class BattleScene extends Phaser.Scene {
  private battle!: Battle;
  private knight!: Fighter;
  private foe!: Fighter;

  constructor() {
    super("battle");
  }

  create(data: { kind: BattleKind; step?: number; building?: string }): void {
    void this.start(data);
  }

  private async start(data: { kind: BattleKind; step?: number; building?: string }): Promise<void> {
    const { game, ui } = services(this);
    try {
      this.battle =
        data.kind === "patrol"
          ? game.startPatrol()
          : data.kind === "repair"
            ? await game.startRepair(data.building!)
            : game.startBattle(data.step!, data.kind);
    } catch (e) {
      // The city can be out of date (e.g. the building was repaired in another battle).
      showMenu(ui, "Сейчас не получится", [e instanceof Error ? e.message : String(e)], [{ label: "В город", primary: true, run: () => this.scene.start("city") }], false);
      return;
    }
    const { width } = this.scale;
    this.cameras.main.setBackgroundColor(data.kind === "boss" ? 0x2a1a1a : data.kind === "encounter" ? 0x1f2433 : 0x1f2f2a);

    const b = this.battle;
    const building = game.repairTarget(b);
    const title =
      b.kind === "boss"
        ? `Босс модуля «${b.module!.title.ru}»`
        : b.kind === "patrol"
          ? "Дневной патруль"
          : b.kind === "repair"
            ? `Ремонт: ${building?.name.ru ?? ""}`
            : b.module!.title.ru;
    this.add.text(width / 2, 24, title, { fontFamily: "Georgia, serif", fontSize: "18px", color: "#c9bb94" }).setOrigin(0.5);
    const subtitle =
      b.kind === "boss"
        ? `Нужно ${b.need} верных ответов, можно ошибиться ${b.allowedWrong} раз`
        : b.scripted
          ? `${b.script!.length} заданий из того, что пора повторить. Проиграть нельзя: это тренировка.`
          : undefined;
    if (subtitle) this.add.text(width / 2, 48, subtitle, { fontFamily: "system-ui, sans-serif", fontSize: "13px", color: "#c9bb94" }).setOrigin(0.5);

    this.knight = this.fighter(width * 0.22, "Knight", "Рыцарь", 0x3a7bd5, 90);
    const e = this.battle.enemy;
    this.foe = this.fighter(width * 0.78, e.name.en, e.name.ru, ROLE_COLOR[e.role], e.role === "boss" ? 130 : 100);
    this.updateBars();
    void this.loop();
  }

  private fighter(x: number, name: string, nameRu: string, color: number, size: number): Fighter {
    const y = 170;
    const body = this.add.rectangle(x, y, size, size, color).setStrokeStyle(3, 0xf3e7c4);
    this.add.text(x, y, name.slice(0, 1), { fontFamily: "Georgia, serif", fontSize: `${size / 2}px`, color: "#ffffff" }).setOrigin(0.5);
    this.add.text(x, y - size / 2 - 40, name, { fontFamily: "Georgia, serif", fontSize: "18px", color: "#f3e7c4" }).setOrigin(0.5);
    this.add.text(x, y - size / 2 - 20, nameRu, { fontFamily: "system-ui, sans-serif", fontSize: "12px", color: "#c9bb94" }).setOrigin(0.5);
    const barWidth = 160;
    this.add.rectangle(x, y + size / 2 + 20, barWidth, 12, 0x000000, 0.5).setStrokeStyle(1, 0xf3e7c4);
    const bar = this.add.rectangle(x - barWidth / 2, y + size / 2 + 20, barWidth, 12, 0x4caf6a).setOrigin(0, 0.5);
    const hpText = this.add.text(x, y + size / 2 + 38, "", { fontFamily: "system-ui, sans-serif", fontSize: "12px", color: "#f3e7c4" }).setOrigin(0.5);
    return { body, bar, hpText, barWidth };
  }

  private updateBars(): void {
    const b = this.battle;
    const set = (f: Fighter, hp: number, max: number) => {
      this.tweens.add({ targets: f.bar, width: (f.barWidth * hp) / max, duration: 250 });
      f.hpText.setText(`${Math.ceil(hp)} / ${max}`);
    };
    set(this.knight, b.knightHp, b.knightMaxHp);
    set(this.foe, b.enemyHp, b.enemyMaxHp);
  }

  private lunge(attacker: Fighter, target: Fighter): Promise<void> {
    return new Promise((resolve) => {
      const dx = (target.body.x - attacker.body.x) * 0.25;
      this.tweens.add({ targets: attacker.body, x: attacker.body.x + dx, duration: 120, yoyo: true, onComplete: () => resolve() });
      this.cameras.main.shake(120, 0.004);
    });
  }

  private async loop(): Promise<void> {
    const { game, ui } = services(this);
    const labels = new Map(game.bundle.taxonomy.error_types.map((t) => [t.id, t.label.ru]));
    while (this.battle.state === "ongoing") {
      const task = this.battle.nextTask();
      const answer = await askTask(ui, task, { hintsLeft: this.battle.hintsLeft });
      const { outcome, strike } = await game.answer(this.battle, task, answer);
      if (strike.kind === "miss") await this.lunge(this.foe, this.knight);
      else await this.lunge(this.knight, this.foe);
      this.updateBars();
      if (!outcome.correct) await showFeedback(ui, outcome, strike, outcome.errorType ? labels.get(outcome.errorType) : undefined);
    }
    const end = await game.finishBattle(this.battle);
    void game.sync();
    await this.finish(end);
  }

  private async finish(end: BattleEnd): Promise<void> {
    const { ui } = services(this);
    const b = this.battle;
    if (end.state === "won") this.tweens.add({ targets: this.foe.body, alpha: 0, angle: 90, duration: 500 });
    else this.tweens.add({ targets: this.knight.body, alpha: 0.3, duration: 500 });

    const lines = [`Верных ответов: ${b.correct} из ${b.answered}`];
    if (end.moduleResult) {
      lines.push(`Результат модуля: ${Math.round(end.moduleResult.scaled * 100)}% (нужно ${Math.round(b.module!.mastery.pass_score * 100)}%)`);
    }
    if (end.earned.xp || end.earned.kp) lines.push(`Награда: +${end.earned.xp} XP, +${end.earned.kp} KP`);
    if (end.patrolRewarded === false) lines.push("Награда за патруль сегодня уже получена; XP за ответы засчитан.");
    if (end.levelUp) lines.push(`Новый уровень рыцаря: ${end.levelUp}!`);
    if (end.unlockedBuilding) lines.push(`В городе открылась стройка: ${end.unlockedBuilding.name.ru} (${end.unlockedBuilding.cost_kp} KP).`);
    if (end.repaired.length) lines.push(`Отремонтировано: ${end.repaired.map((x) => x.name.ru).join(", ")}.`);
    const title =
      b.kind === "patrol"
        ? "Патруль окончен"
        : b.kind === "repair"
          ? end.repaired.length
            ? "Ремонт окончен"
            : "Работа продвинулась, но трещины остались. Повтори ещё."
          : end.state === "won"
            ? b.kind === "boss"
              ? `Победа над боссом: ${b.enemy.name.ru}. Модуль освоен!`
              : `Победа: ${b.enemy.name.ru}`
            : b.kind === "boss"
              ? "Рыцарь отступает. Потренируйся в обычных боях и возвращайся."
              : "Рыцарь отступает.";
    const home = b.scripted || end.unlockedBuilding ? "city" : "map";
    const back = async () => {
      if (end.outro) await playStory(ui, end.outro);
      this.scene.start(home);
    };
    showMenu(ui, title, lines, [{ label: home === "city" ? "В город" : "На карту", primary: true, run: () => void back() }], false);
  }
}
