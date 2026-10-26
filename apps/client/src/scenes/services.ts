import type Phaser from "phaser";
import type { Game } from "../game/game.js";

export interface Services {
  game: Game;
  /** DOM layer over the canvas: task panels, dialogs and menus live here, not on the canvas. */
  ui: HTMLElement;
}

export function services(scene: Phaser.Scene): Services {
  return scene.registry.get("services") as Services;
}
