import Phaser from "phaser";
import type { Game } from "../game/game.js";

const FONT = "system-ui, sans-serif";

/** Level, XP towards the next level and KP, top left. Shared by the map and the city. */
export function drawHud(scene: Phaser.Scene, game: Game): void {
  const h = game.hud();
  const x = 16;
  const y = 14;
  scene.add.text(x, y, `Рыцарь · уровень ${h.level}`, { fontFamily: "Georgia, serif", fontSize: "16px", color: "#f3e7c4" });
  const barW = 160;
  scene.add.rectangle(x, y + 30, barW, 8, 0x000000, 0.5).setOrigin(0, 0.5).setStrokeStyle(1, 0x8a7448);
  const share = h.nextLevelXp === undefined ? 1 : (h.xp - h.levelStartXp) / (h.nextLevelXp - h.levelStartXp);
  scene.add.rectangle(x, y + 30, Math.max(0, Math.min(1, share)) * barW, 8, 0xd5b03a).setOrigin(0, 0.5);
  scene.add.text(x + barW + 8, y + 22, h.nextLevelXp === undefined ? `${h.xp} XP` : `${h.xp} / ${h.nextLevelXp} XP`, { fontFamily: FONT, fontSize: "12px", color: "#c9bb94" });
  scene.add.text(x, y + 42, `KP ${h.kp}  ·  HP ${h.maxHp}`, { fontFamily: FONT, fontSize: "13px", color: "#c9bb94" });
}

/** A canvas button for scene navigation; menus and tasks stay in the DOM. */
export function textButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  label: string,
  run: () => void,
  o: { primary?: boolean; disabled?: boolean } = {},
): Phaser.GameObjects.Text {
  const t = scene.add
    .text(x, y, label, {
      fontFamily: FONT,
      fontSize: "15px",
      color: o.primary ? "#1a1208" : "#f3e7c4",
      backgroundColor: o.primary ? "#d58a3a" : "#2b261d",
      padding: { x: 14, y: 9 },
    })
    .setOrigin(0.5);
  if (o.disabled) return t.setAlpha(0.45);
  t.setInteractive({ useHandCursor: true }).on("pointerdown", run);
  t.on("pointerover", () => t.setAlpha(0.85)).on("pointerout", () => t.setAlpha(1));
  return t;
}
