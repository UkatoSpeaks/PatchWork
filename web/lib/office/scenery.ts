// The room shell: floors, walls, doors, the light falling in through the
// windows, and everything hung on the walls (windows, whiteboard, test TV,
// clock, posters, signs). Floors and walls never change, so they are drawn
// once into a cached canvas; wall items with moving parts are drawn per frame.

import { DOOR_COLUMNS, MID_FACE, ROOM_WALLS, TILE, TOP_FACE, roomFloor, type TileKind, type WallItem } from "./layout";
import type { MonitorState } from "./reducer";
import { PALETTE, box, drawText, noise, rect, textWidth, withAlpha } from "./sprites";

type Ctx = CanvasRenderingContext2D;
const P = PALETTE;

// --- floors ----------------------------------------------------------------------------

function varied(hex: string, amount: number): string {
  const c = (i: number) => Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 + amount))));
  return `#${[1, 3, 5].map((i) => c(i).toString(16).padStart(2, "0")).join("")}`;
}

export function drawFloor(ctx: Ctx, kind: TileKind, tx: number, ty: number): void {
  const x = tx * TILE, y = ty * TILE;
  const n = noise(tx, ty);
  switch (kind) {
    case "sage": {
      // slight per-tile colour variation, faint grout on two edges
      rect(ctx, varied(P.sage, (n - 0.5) * 0.06), x, y, TILE, TILE);
      rect(ctx, "rgba(70,84,58,0.10)", x, y, TILE, 1);
      rect(ctx, "rgba(70,84,58,0.10)", x, y + 1, 1, TILE - 1);
      if (n > 0.7) rect(ctx, "rgba(255,255,255,0.08)", x + 3 + Math.floor(n * 8), y + 4, 3, 1);
      break;
    }
    case "carpetLead":
    case "carpetMeeting": {
      const base = kind === "carpetLead" ? P.carpetLead : P.carpetMeeting;
      const dot = kind === "carpetLead" ? P.carpetLeadDot : P.carpetMeetingDot;
      rect(ctx, varied(base, (n - 0.5) * 0.03), x, y, TILE, TILE);
      for (let i = 0; i < 6; i++) {
        const a = noise(tx * 7 + i, ty * 3 + i, 1);
        rect(ctx, dot, x + Math.floor(a * 15), y + Math.floor(noise(tx, ty, i + 2) * 15), 1, 1);
      }
      break;
    }
    case "kitchen":
      for (let i = 0; i < 4; i++) {
        const cx = i % 2, cy = Math.floor(i / 2);
        rect(ctx, (cx + cy) % 2 ? P.kitchenB : P.kitchenA, x + cx * 8, y + cy * 8, 8, 8);
      }
      rect(ctx, "rgba(90,70,50,0.12)", x, y, TILE, 1);
      rect(ctx, "rgba(90,70,50,0.12)", x, y, 1, TILE);
      break;
    default:
      rect(ctx, P.sage, x, y, TILE, TILE);
  }
}

// --- walls -----------------------------------------------------------------------------

export function drawWallCap(ctx: Ctx, tx: number, ty: number): void {
  const x = tx * TILE, y = ty * TILE;
  rect(ctx, P.wallCap, x, y, TILE, TILE);
  rect(ctx, P.wallCapHi, x, y, TILE, 2);
  if (noise(tx, ty, 9) > 0.6) rect(ctx, "#463d3a", x + 4, y + 7, 6, 1);
}

/** The colour of a wall face: each top room has its own paint. */
function wallPaint(tx: number, ty: number): { face: string; shade: string } {
  if (ty < MID_FACE) {
    if (tx < ROOM_WALLS[0]) return { face: "#e9d6bd", shade: "#d9c2a3" };
    if (tx < ROOM_WALLS[1]) return { face: "#dbe3e1", shade: "#c5d0ce" };
    return { face: "#efe7c9", shade: "#ddd2ad" };
  }
  return { face: P.wallFace, shade: P.wallFaceShade };
}

/** A wall face is two rows tall: `lower` is its bottom row, with the skirting board. */
export function drawWallFace(ctx: Ctx, tx: number, ty: number, lower: boolean): void {
  const x = tx * TILE, y = ty * TILE;
  const { face, shade } = wallPaint(tx, ty);
  rect(ctx, face, x, y, TILE, TILE);
  // faint vertical wallpaper stripes
  for (let i = 2; i < TILE; i += 6) rect(ctx, withAlpha(shade, 0.35), x + i, y, 1, TILE);
  if (!lower) {
    rect(ctx, shade, x, y, TILE, 3); // shadow under the wall top
    rect(ctx, withAlpha(shade, 0.6), x, y + 3, TILE, 1);
  } else {
    const kitchen = ty < MID_FACE && tx > ROOM_WALLS[1];
    if (kitchen) {
      // tiled splashback behind the counter
      for (let i = 0; i < 2; i++) rect(ctx, "#f6f1e3", x, y + i * 5, TILE, 4);
      rect(ctx, "#cfc5a8", x + ((tx * 5) % 8), y, 1, 9);
    }
    rect(ctx, P.baseboard, x, y + 12, TILE, 4);
    rect(ctx, "#a2856a", x, y + 12, TILE, 1);
  }
}

/** A doorway through the middle wall: row 9 is the threshold, rows 10-11 the opening. */
export function drawDoor(ctx: Ctx, tx: number, ty: number): void {
  const x = tx * TILE, y = ty * TILE;
  const room = roomFloor(tx);
  if (ty === 9) {
    drawFloor(ctx, room, tx, ty);
    rect(ctx, P.wallCap, x, y, 2, TILE);
    rect(ctx, P.wallCap, x + 14, y, 2, TILE);
    return;
  }
  drawFloor(ctx, ty === MID_FACE ? room : "sage", tx, ty);
  rect(ctx, "rgba(43,37,35,0.22)", x + 2, y, 12, TILE); // the opening is in shadow
  // frame posts and lintel
  rect(ctx, "#7a5134", x, y, 2, TILE);
  rect(ctx, "#7a5134", x + 14, y, 2, TILE);
  rect(ctx, "#93643f", x + 1, y, 1, TILE);
  if (ty === MID_FACE) {
    rect(ctx, "#7a5134", x, y, TILE, 3);
    rect(ctx, "#93643f", x, y + 2, TILE, 1);
  } else {
    rect(ctx, "#6e4529", x, y + 12, 2, 4);
    rect(ctx, "#6e4529", x + 14, y + 12, 2, 4);
  }
}

/** Warm light falling in through a window onto the floor below it. */
export function drawWindowLight(ctx: Ctx, item: WallItem): void {
  if (item.kind !== "window" || item.y !== TOP_FACE) return;
  const x = item.x * TILE + 2, w = item.w * TILE - 4;
  const top = (TOP_FACE + 2) * TILE;
  for (let i = 0; i < 34; i++) {
    const alpha = 0.16 * (1 - i / 34);
    rect(ctx, `rgba(255,232,170,${alpha.toFixed(3)})`, x + Math.floor(i * 0.4), top + i, w, 1);
  }
}

// --- wall items ------------------------------------------------------------------------

export function drawWindow(ctx: Ctx, x: number, y: number, wTiles: number, t: number): void {
  const w = wTiles * TILE - 4;
  const left = x + 2, top = y + 4;
  const h = 20;
  rect(ctx, P.frame, left, top, w, h);
  // sky: a soft gradient, a cloud drifting by, a far-off skyline
  for (let i = 0; i < h - 4; i++) rect(ctx, i < 6 ? "#a9d3e4" : i < 11 ? "#bfdfe8" : "#d3e9ec", left + 2, top + 2 + i, w - 4, 1);
  const cloudX = left + 3 + Math.floor(((t / 5000) * 8 + x) % Math.max(1, w - 12));
  rect(ctx, P.glassHi, cloudX, top + 5, 7, 2);
  rect(ctx, P.glassHi, cloudX + 2, top + 4, 3, 1);
  for (let i = 0; i < w - 4; i += 4) {
    const bh = 2 + Math.floor(noise(x + i, y) * 5);
    rect(ctx, "#93b6c0", left + 2 + i, top + h - 2 - bh, 3, bh);
  }
  // mullions and glare
  rect(ctx, P.frame, left + Math.floor(w / 2) - 1, top, 2, h);
  rect(ctx, P.frame, left, top + 9, w, 1);
  rect(ctx, "rgba(255,255,255,0.45)", left + 3, top + 3, 1, 4);
  rect(ctx, "rgba(255,255,255,0.45)", left + 4, top + 3, 1, 2);
  // sill
  rect(ctx, "#c9b48f", left - 2, top + h, w + 4, 2);
  rect(ctx, "#a8916c", left - 2, top + h + 2, w + 4, 1);
}

export function drawCalendar(ctx: Ctx, x: number, y: number): void {
  box(ctx, P.paper, x + 3, y + 5, 10, 13);
  rect(ctx, P.red, x + 4, y + 6, 8, 3);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) rect(ctx, r === 1 && c === 1 ? P.red : "#b8ad9a", x + 5 + c * 3, y + 10 + r * 2, 1, 1);
  rect(ctx, P.ink, x + 7, y + 4, 2, 1);
}

/** The wall clock shows the run's elapsed time (hands plus a small readout). */
export function drawClock(ctx: Ctx, x: number, y: number, elapsed: number): void {
  const cx = x + 8, cy = y + 9;
  rect(ctx, P.ink, cx - 5, cy - 7, 10, 14);
  rect(ctx, P.ink, cx - 7, cy - 5, 14, 10);
  rect(ctx, P.ink, cx - 6, cy - 6, 12, 12);
  rect(ctx, P.paper, cx - 4, cy - 6, 8, 12);
  rect(ctx, P.paper, cx - 6, cy - 4, 12, 8);
  rect(ctx, P.paper, cx - 5, cy - 5, 10, 10);
  for (const [dx, dy] of [[0, -5], [4, 0], [0, 4], [-5, 0]]) rect(ctx, "#8b7d6e", cx + dx, cy + dy, 1, 1);
  const hand = (angle: number, length: number, color: string) => {
    for (let i = 1; i <= length; i++) rect(ctx, color, cx + Math.round(Math.sin(angle) * i), cy - Math.round(Math.cos(angle) * i), 1, 1);
  };
  const seconds = Math.floor(elapsed);
  hand(((seconds / 60) % 60) / 60 * Math.PI * 2, 3, P.ink);
  hand((seconds % 60) / 60 * Math.PI * 2, 4, P.red);
  rect(ctx, P.ink, cx, cy, 1, 1);
  // readout plate under the clock: m:ss since the run started
  const label = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const w = textWidth(label) + 4;
  box(ctx, "#22303a", cx - Math.ceil(w / 2), cy + 8, w, 9);
  drawText(ctx, label, cx - Math.ceil(w / 2) + 2, cy + 10, "#9fe0b0");
}

export function drawPoster(ctx: Ctx, x: number, y: number, variant = 0): void {
  const left = x + 2, top = y + 4;
  box(ctx, P.paper, left, top, 12, 17);
  rect(ctx, "#b8ad9a", left + 5, top - 1, 2, 1); // pin
  switch (variant % 4) {
    case 0: // a little rocket: "ship it"
      rect(ctx, "#2f3a56", left + 1, top + 1, 10, 11);
      rect(ctx, P.paper, left + 5, top + 3, 2, 6);
      rect(ctx, P.red, left + 5, top + 2, 2, 1);
      rect(ctx, P.red, left + 4, top + 7, 1, 2);
      rect(ctx, P.red, left + 7, top + 7, 1, 2);
      rect(ctx, P.mustard, left + 5, top + 9, 2, 2);
      rect(ctx, "#f4ead5", left + 2, top + 2, 1, 1);
      rect(ctx, "#f4ead5", left + 9, top + 5, 1, 1);
      drawText(ctx, "GO", left + 3, top + 12, P.red);
      break;
    case 1: // mountains
      rect(ctx, "#bfdfe8", left + 1, top + 1, 10, 11);
      rect(ctx, P.mustard, left + 8, top + 2, 2, 2);
      for (let i = 0; i < 5; i++) rect(ctx, "#6a9655", left + 1 + i, top + 11 - i * 2, 10 - i * 2, 1);
      rect(ctx, "#4d7340", left + 1, top + 11, 10, 1);
      rect(ctx, "#5a4f4a", left + 2, top + 13, 8, 1);
      rect(ctx, "#5a4f4a", left + 2, top + 15, 5, 1);
      break;
    case 2: // a bar chart
      rect(ctx, "#f4ead5", left + 1, top + 1, 10, 11);
      [4, 7, 5, 9].forEach((h, i) => rect(ctx, [P.blue, P.green, P.mustard, P.red][i], left + 2 + i * 2, top + 11 - h, 1, h));
      rect(ctx, P.ink, left + 1, top + 11, 10, 1);
      rect(ctx, "#5a4f4a", left + 2, top + 13, 8, 1);
      break;
    default: // "no bugs": a bug in a red circle
      rect(ctx, P.mustard, left + 1, top + 1, 10, 11);
      rect(ctx, P.red, left + 3, top + 2, 6, 9);
      rect(ctx, P.red, left + 2, top + 3, 8, 7);
      rect(ctx, P.mustard, left + 4, top + 3, 4, 7);
      rect(ctx, P.ink, left + 5, top + 4, 2, 5);
      rect(ctx, P.ink, left + 4, top + 5, 4, 1);
      rect(ctx, P.ink, left + 4, top + 7, 4, 1);
      rect(ctx, P.red, left + 3, top + 9, 6, 1);
      drawText(ctx, "QA", left + 3, top + 12, P.ink);
  }
}

/** A small room sign: light letters on a dark plaque. */
export function drawSign(ctx: Ctx, x: number, y: number, wTiles: number, text: string): void {
  const w = textWidth(text) + 6;
  const left = Math.round(x + (wTiles * TILE - w) / 2);
  rect(ctx, "rgba(43,37,35,0.18)", left + 1, y + 5, w, 9);
  box(ctx, "#3f4a52", left, y + 4, w, 9);
  rect(ctx, "#56636c", left + 1, y + 5, w - 2, 1);
  drawText(ctx, text, left + 3, y + 6, "#f4ead5");
}

export function drawNoticeBoard(ctx: Ctx, x: number, y: number, wTiles: number): void {
  const w = wTiles * TILE - 6;
  const left = x + 3, top = y + 4;
  box(ctx, "#c99a64", left, top, w, 18, "#7a5134");
  for (let i = 0; i < 8; i++) {
    const nx = left + 2 + ((i * 11) % (w - 8));
    const ny = top + 2 + ((i * 5) % 10);
    const colors = ["#fbf7ee", "#f3d36b", "#9ad08a", "#f0a08a", "#bcd8de"];
    rect(ctx, colors[i % colors.length], nx, ny, 5, 5);
    rect(ctx, P.red, nx + 2, ny, 1, 1);
    rect(ctx, "#b8ad9a", nx + 1, ny + 2, 3, 1);
  }
}

export function drawWhiteboard(ctx: Ctx, x: number, y: number, wTiles: number, lines: number, planned: boolean, t: number): void {
  const w = wTiles * TILE - 6;
  const left = x + 3, top = y + 2;
  const h = 24;
  rect(ctx, "rgba(43,37,35,0.18)", left + 2, top + 2, w, h);
  rect(ctx, "#9aa0a6", left, top, w, h);
  rect(ctx, "#fcfcf8", left + 1, top + 1, w - 2, h - 2);
  rect(ctx, "#eef0ee", left + 1, top + h - 5, w - 2, 4);
  drawText(ctx, "PLAN", left + 3, top + 2, P.red);
  rect(ctx, P.red, left + 3, top + 8, 15, 1);
  // the plan's lines, the newest still being written
  const shown = Math.min(lines, 8);
  for (let i = 0; i < shown; i++) {
    const col = Math.floor(i / 4);
    const row = top + 10 + (i % 4) * 3;
    const cx = left + 3 + col * 44;
    rect(ctx, P.blue, cx, row, 2, 1);
    const length = 14 + Math.floor(noise(i, 3) * 18);
    const drawn = i === shown - 1 && !planned ? Math.min(length, 4 + Math.floor((t / 110) % (length - 3))) : length;
    rect(ctx, "#3b3b42", cx + 4, row, drawn, 1);
  }
  if (planned) {
    // sticky notes: the subtasks, colour-coded by role
    const notes = ["#9ad08a", "#9fc4e8", "#9fc4e8"];
    notes.forEach((c, i) => {
      rect(ctx, c, left + w - 30 + i * 9, top + 3 + (i % 2) * 2, 7, 7);
      rect(ctx, "rgba(43,37,35,0.25)", left + w - 29 + i * 9, top + 6 + (i % 2) * 2, 5, 1);
    });
  }
  // marker tray
  rect(ctx, "#8a8f94", left + 6, top + h, w - 12, 2);
  rect(ctx, P.red, left + 12, top + h - 1, 4, 1);
  rect(ctx, P.blue, left + 18, top + h - 1, 4, 1);
  rect(ctx, "#2b2523", left + 24, top + h - 1, 4, 1);
}

export function drawTestMonitor(ctx: Ctx, x: number, y: number, wTiles: number, m: MonitorState, t: number): void {
  const w = wTiles * TILE - 4;
  const left = x + 2, top = y + 2;
  const h = 24;
  rect(ctx, "rgba(43,37,35,0.22)", left + 2, top + 2, w, h);
  rect(ctx, "#1d1a19", left, top, w, h);
  const bg = m.status === "pass" ? "#24502c" : m.status === "fail" ? "#5e231c" : "#1f2c35";
  rect(ctx, bg, left + 2, top + 2, w - 4, h - 5);
  // scanlines
  for (let i = 0; i < h - 5; i += 2) rect(ctx, "rgba(255,255,255,0.04)", left + 2, top + 2 + i, w - 4, 1);
  const fg = m.status === "pass" ? P.greenHi : m.status === "fail" ? P.redHi : "#7f97a6";
  drawText(ctx, "TESTS", left + 4, top + 3, "#c8d3da");
  if (m.status === "idle") {
    if (Math.floor(t / 500) % 2) rect(ctx, fg, left + 4, top + 10, 3, 5);
  } else {
    drawText(ctx, m.status === "pass" ? "PASS" : `${m.failed ?? "?"} FAIL`, left + 4, top + 9, fg);
    if (m.passed != null) drawText(ctx, `${m.passed} OK`, left + 4, top + 15, "#c8d3da");
  }
  rect(ctx, fg, left + w - 7, top + 4, 3, 3);
  rect(ctx, "#3b3b42", left + w / 2 - 3, top + h - 2, 6, 1);
  rect(ctx, Math.floor(t / 900) % 2 ? "#e05a47" : "#6b2a22", left + w - 5, top + h - 2, 1, 1);
}

export { DOOR_COLUMNS };
