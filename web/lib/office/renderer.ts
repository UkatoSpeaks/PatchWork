// Draws one frame of the office from the scene state and the actors' positions:
// the cached room shell, wall items, furniture and characters sorted by depth,
// the success / failure effects and a soft vignette. Speech bubbles are not
// drawn here: they are an HTML overlay (BubbleOverlay) so text stays crisp.

import type { CrewAgent } from "../types";
import type { Actors } from "./animator";
import { drawCharacter } from "./characters";
import { drawFurniture, sortYOf, type FurnitureState } from "./furniture";
import { COFFEE_MACHINE, COLS, FURNITURE, HEIGHT, MID_FACE, ROWS, TILE, WALL_ITEMS, WIDTH, tileKind } from "./layout";
import { CREW, elapsedSeconds, type SceneState } from "./reducer";
import * as W from "./scenery";
import { drawConfetti, drawRainCloud } from "./sprites";

type Ctx = CanvasRenderingContext2D;

export const SELECTION_COLOR = "#ffe27a";

let background: HTMLCanvasElement | null = null;
let vignette: HTMLCanvasElement | null = null;

/** Floors, walls and the static wall decorations never change: draw them once. */
function drawBackground(): HTMLCanvasElement {
  if (background) return background;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d")!;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const kind = tileKind(x, y);
      if (kind === "cap") W.drawWallCap(ctx, x, y);
      else if (kind === "face") W.drawWallFace(ctx, x, y, kind === tileKind(x, y - 1));
      else if (kind === "door") W.drawDoor(ctx, x, y);
      else W.drawFloor(ctx, kind, x, y);
    }
  }
  // a soft shadow cast by the walls onto the floor below them
  for (let x = 1; x < COLS - 1; x++) {
    for (const y of [3, MID_FACE + 2]) {
      if (tileKind(x, y) === "cap") continue;
      ctx.fillStyle = "rgba(43,37,35,0.10)";
      ctx.fillRect(x * TILE, y * TILE, TILE, 3);
    }
  }
  for (const item of WALL_ITEMS) {
    const x = item.x * TILE, y = item.y * TILE;
    if (item.kind === "calendar") W.drawCalendar(ctx, x, y);
    else if (item.kind === "poster") W.drawPoster(ctx, x, y, item.variant);
    else if (item.kind === "sign") W.drawSign(ctx, x, y, item.w, item.text ?? "");
    else if (item.kind === "noticeBoard") W.drawNoticeBoard(ctx, x, y, item.w);
    else if (item.kind === "window") W.drawWindowLight(ctx, item);
  }
  background = canvas;
  return canvas;
}

function drawVignette(): HTMLCanvasElement {
  if (vignette) return vignette;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(WIDTH / 2, HEIGHT / 2, HEIGHT * 0.45, WIDTH / 2, HEIGHT / 2, WIDTH * 0.62);
  gradient.addColorStop(0, "rgba(30,20,15,0)");
  gradient.addColorStop(1, "rgba(30,20,15,0.32)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  vignette = canvas;
  return canvas;
}

interface Drawable {
  sortY: number;
  draw: () => void;
}

const WORKING = new Set(["thinking", "typing", "testing"]);

export interface FrameInput {
  scene: SceneState;
  actors: Actors;
  // animation time in ms
  t: number;
  // seconds since the run's outcome appeared, or null
  outcomeSeconds: number | null;
  selected: CrewAgent | null;
}

export function drawScene(ctx: Ctx, { scene, actors, t, outcomeSeconds, selected }: FrameInput): void {
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(drawBackground(), 0, 0);

  const planned = scene.agents.lead.activity === "done" || scene.phase !== "plan" && scene.whiteboardLines > 0;
  for (const item of WALL_ITEMS) {
    const x = item.x * TILE, y = item.y * TILE;
    if (item.kind === "window") W.drawWindow(ctx, x, y, item.w, t);
    else if (item.kind === "clock") W.drawClock(ctx, x, y, elapsedSeconds(scene));
    else if (item.kind === "whiteboard") W.drawWhiteboard(ctx, x, y, item.w, scene.whiteboardLines, planned, t);
    else if (item.kind === "testMonitor") W.drawTestMonitor(ctx, x, y, item.w, scene.monitor, t);
  }

  const views = Object.fromEntries(CREW.map((agent) => [agent, actors.view(agent)])) as Record<CrewAgent, ReturnType<Actors["view"]>>;
  const furnitureState: FurnitureState = {
    t,
    screen: (owner) => {
      const state = scene.agents[owner];
      const atDesk = actors.isSeated(owner) && actors.actors[owner].home.seat === "chair";
      if (WORKING.has(state.activity) || (atDesk && views[owner].pose === "type")) return { busy: state.activity === "typing" || state.activity === "testing" || views[owner].pose === "type" };
      return null;
    },
    coffeeInUse: CREW.some((agent) => {
      const actor = actors.actors[agent];
      return views[agent].pose === "drink" && views[agent].cup === "mug" && actor.tile.y === COFFEE_MACHINE.y + 1;
    }),
    mergeActive: scene.phase === "integrate",
  };

  const drawables: Drawable[] = FURNITURE.map((item) => ({ sortY: sortYOf(item), draw: () => drawFurniture(ctx, item, furnitureState) }));

  for (const agent of CREW) {
    const actor = actors.actors[agent];
    const state = scene.agents[agent];
    const view = views[agent];
    const x = Math.round(actor.px), y = Math.round(actor.py);
    const options = {
      facing: view.facing,
      pose: view.pose,
      t,
      walked: actor.walked,
      grey: state.activity === "cancelled" || !state.inRun,
      highlight: selected === agent ? SELECTION_COLOR : null,
      cup: view.cup,
    };
    const atDesk = (view.pose === "type" || view.pose === "sit") && actor.home.seat === "chair";
    drawables.push({ sortY: y + 15, draw: () => drawCharacter(ctx, agent, x, y, { ...options, layer: "body" }) });
    // hands rest on the desk in front of the chair, so draw them after it
    if (atDesk) drawables.push({ sortY: y + 2 * TILE - 0.5, draw: () => drawCharacter(ctx, agent, x, y, { ...options, layer: "front" }) });
  }

  drawables.sort((a, b) => a.sortY - b.sortY);
  for (const d of drawables) d.draw();

  if (scene.outcome && outcomeSeconds != null) {
    if (scene.outcome === "success") drawConfetti(ctx, WIDTH / 2, 0, WIDTH, HEIGHT, outcomeSeconds);
    else {
      const failed = scene.failedAgent ? actors.actors[scene.failedAgent] : null;
      const cx = failed ? failed.px + 8 : WIDTH / 2;
      const top = failed ? Math.max(2, failed.py - 36) : 70;
      drawRainCloud(ctx, cx, top, outcomeSeconds);
    }
  }
  ctx.drawImage(drawVignette(), 0, 0);
}

// The whiteboard in the meeting room opens the plan when clicked.
const BOARD = WALL_ITEMS.find((item) => item.kind === "whiteboard")!;
export const WHITEBOARD_RECT = { x: BOARD.x * TILE + 3, y: BOARD.y * TILE + 2, w: BOARD.w * TILE - 6, h: 26 };

/** What's under a point in scene pixels: a character, the whiteboard, or nothing. */
export function hitTest(actors: Actors, x: number, y: number): CrewAgent | "whiteboard" | null {
  let best: CrewAgent | null = null;
  for (const agent of CREW) {
    const actor = actors.actors[agent];
    const inside = x >= actor.px && x < actor.px + TILE && y >= actor.py - 12 && y < actor.py + TILE;
    if (inside && (!best || actor.py > actors.actors[best].py)) best = agent;
  }
  if (best) return best;
  const r = WHITEBOARD_RECT;
  if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return "whiteboard";
  return null;
}
