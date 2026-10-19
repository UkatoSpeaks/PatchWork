// Draws one frame of the office from the scene state and the actors' positions.

import type { CrewAgent } from "../types";
import type { Actors } from "./animator";
import { COLS, FURNITURE, HEIGHT, ROWS, TILE, WALL_ITEMS, WHITEBOARD_SPOT, WIDTH, doorFloor, tileKind } from "./layout";
import { CREW, type SceneState } from "./reducer";
import * as S from "./sprites";

type Ctx = CanvasRenderingContext2D;

let background: HTMLCanvasElement | null = null;

/** Floors and walls never change: draw them once. */
function drawBackground(): HTMLCanvasElement {
  if (background) return background;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d")!;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const kind = tileKind(x, y);
      if (kind === "cap") S.drawWallCap(ctx, x, y);
      else if (kind === "face") S.drawWallFace(ctx, x, y);
      else if (kind === "door") {
        S.drawFloor(ctx, y === 8 ? "sage" : doorFloor(x), x, y);
        S.drawDoorFrame(ctx, x, y);
      } else S.drawFloor(ctx, kind, x, y);
    }
  }
  background = canvas;
  return canvas;
}

interface Drawable {
  sortY: number;
  draw: () => void;
}

const ACTIVE = new Set(["thinking", "typing", "testing", "waiting"]);

export function drawScene(ctx: Ctx, scene: SceneState, actors: Actors, t: number, outcomeSeconds: number | null): void {
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(drawBackground(), 0, 0);

  for (const item of WALL_ITEMS) {
    const x = item.x * TILE, y = item.y * TILE;
    if (item.kind === "window") S.drawWindow(ctx, x, y, item.w, t);
    else if (item.kind === "calendar") S.drawCalendar(ctx, x, y);
    else if (item.kind === "clock") S.drawClock(ctx, x, y, t);
    else if (item.kind === "poster") S.drawPoster(ctx, x, y);
    else if (item.kind === "whiteboard") S.drawWhiteboard(ctx, x, y, item.w, scene.whiteboardLines, t);
    else if (item.kind === "testMonitor") S.drawTestMonitor(ctx, x, y, item.w, scene.monitor, t);
  }

  const atCoffee = CREW.some((a) => scene.agents[a].place === "coffee" && actors.actors[a].tile.y === 3 && !actors.isWalking(a));
  const drawables: Drawable[] = [];

  for (const item of FURNITURE) {
    const x = item.x * TILE, y = item.y * TILE;
    const bottom = (item.y + item.h) * TILE;
    const draw = (): void => {
      switch (item.kind) {
        case "desk":
          return S.drawDesk(ctx, x, y, item.w, item.owner ? ACTIVE.has(scene.agents[item.owner].activity) : false, t);
        case "plant":
          return S.drawPlant(ctx, x, y, t);
        case "bookshelf":
          return S.drawBookshelf(ctx, x, y, item.w);
        case "meetingTable":
          return S.drawMeetingTable(ctx, x, y, item.w, item.h);
        case "counter":
          return S.drawCounter(ctx, x, y, item.w, atCoffee, t);
        case "fridge":
          return S.drawFridge(ctx, x, y);
        case "kitchenTable":
          return S.drawKitchenTable(ctx, x, y, item.w);
        case "mergeTable":
          return S.drawMergeTable(ctx, x, y, item.w, item.h, scene.phase === "integrate", t);
        case "cooler":
          return S.drawCooler(ctx, x, y);
        case "sofa":
          return S.drawSofa(ctx, x, y, item.w);
        case "divider":
          return S.drawDivider(ctx, x, y, item.h);
        case "chair":
          return S.drawChair(ctx, x, y, item.facing);
        case "rug":
          return S.drawRug(ctx, x, y, item.w, item.h);
      }
    };
    // Rugs lie under everything; chairs under whoever sits near them.
    drawables.push({ sortY: item.kind === "rug" ? -1 : item.kind === "chair" ? bottom - 8 : bottom, draw });
  }

  const overlays: (() => void)[] = [];
  for (const agent of CREW) {
    const actor = actors.actors[agent];
    const state = scene.agents[agent];
    const x = Math.round(actor.px), y = Math.round(actor.py);
    const walking = actors.isWalking(agent);
    const seated = actors.isSeated(agent);
    const busy = state.activity === "typing" || state.activity === "testing";
    let pose: S.Pose = "stand";
    let frame = Math.floor(t / 700) % 2;
    if (walking) {
      pose = "walk";
      frame = Math.floor(actor.walked / 4) % 4;
    } else if (seated) {
      pose = busy ? "type" : "sit";
      frame = busy ? Math.floor(t / 160) % 2 : frame;
    } else if (busy && actor.tile.x === WHITEBOARD_SPOT.x && actor.tile.y === WHITEBOARD_SPOT.y) {
      pose = "write";
      frame = Math.floor(t / 260) % 2;
    }
    const grey = state.activity === "cancelled" || !state.inRun;
    drawables.push({
      sortY: y + TILE,
      draw: () => S.drawCharacter(ctx, agent, x, y, actor.facing, pose, frame, grey),
    });
    overlays.push(() => drawAgentOverlay(ctx, agent, scene, x, y + (seated ? 3 : 0), t));
  }

  drawables.sort((a, b) => a.sortY - b.sortY);
  for (const d of drawables) d.draw();
  for (const overlay of overlays) overlay();

  if (scene.outcome && outcomeSeconds != null) {
    if (scene.outcome === "success") S.drawConfetti(ctx, WIDTH, HEIGHT, outcomeSeconds);
    else {
      const failed = scene.failedAgent ? actors.actors[scene.failedAgent] : null;
      const cx = failed ? failed.px + 8 : WIDTH / 2;
      const top = failed ? Math.max(2, failed.py - 34) : 70;
      S.drawRainCloud(ctx, cx, top, outcomeSeconds);
    }
  }
}

function drawAgentOverlay(ctx: Ctx, agent: CrewAgent, scene: SceneState, x: number, headY: number, t: number): void {
  const state = scene.agents[agent];
  let top = headY - 2;
  const cx = x + 8;
  if (agent === "reviewer" && state.verdict) {
    // a little sign held up above the head
    S.rect(ctx, S.PALETTE.ink, cx - 6, top - 12, 13, 11);
    S.rect(ctx, S.PALETTE.paper, cx - 5, top - 11, 11, 9);
    S.drawIcon(ctx, state.verdict === "approved" ? "check" : "cross", cx - 3, top - 10);
    S.rect(ctx, "#7a5134", cx, top - 1, 1, 2);
    top -= 13;
  }
  if (state.bubble) {
    S.drawBubble(ctx, state.bubble.text, cx, top, state.bubble.icon, WIDTH);
  } else if (state.activity === "thinking") {
    const dots = ".".repeat(1 + (Math.floor(t / 350) % 3)).padEnd(3, " ");
    S.drawBubble(ctx, dots, cx, top, null, WIDTH);
  } else if ((state.activity === "done" || state.activity === "failed") && !(agent === "reviewer" && state.verdict)) {
    S.drawIcon(ctx, state.activity === "done" ? "check" : "cross", x + 11, headY - 6);
  }
}
