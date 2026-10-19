// Everything in the office is drawn here with filled rectangles: tiles,
// furniture, a 3x5 bitmap font and the four crew characters. All coordinates
// are internal canvas pixels; callers pass integer positions.

import type { CrewAgent } from "../types";
import type { Facing, TileKind } from "./layout";
import { TILE } from "./layout";

type Ctx = CanvasRenderingContext2D;

export const PALETTE = {
  ink: "#2b2523",
  cream: "#f4ead5",
  wallCap: "#3d3533",
  wallCapHi: "#514642",
  wallFace: "#e8dcc2",
  wallFaceShade: "#d8c9aa",
  baseboard: "#8b6f55",
  sage: "#a7b593",
  sageAlt: "#9eac8a",
  sageGrout: "#8d9b7b",
  wood: "#c9a173",
  woodAlt: "#bf966a",
  woodSeam: "#a47c53",
  carpet: "#a9b5ab",
  carpetDot: "#9aa79d",
  kitchenA: "#ece0c6",
  kitchenB: "#d4a789",
  deskTop: "#b5804f",
  deskTopHi: "#c79262",
  deskFront: "#8a5a37",
  deskShadow: "rgba(43,37,35,0.18)",
  metal: "#55555d",
  metalDark: "#3b3b42",
  screen: "#79b3ad",
  leaf: "#6a9655",
  leafDark: "#4d7340",
  leafLight: "#86b06a",
  pot: "#b5654a",
  potDark: "#8f4c37",
  glass: "#bcd8de",
  glassHi: "#e8f3f3",
  frame: "#3b3330",
  paper: "#fbf7ee",
  red: "#c0583f",
  green: "#5f9a57",
  greenHi: "#9ad08a",
  redHi: "#f08a74",
  blue: "#4f7cac",
  mustard: "#d9a441",
  bubble: "#fffaf0",
  steam: "rgba(255,255,255,0.75)",
};

// --- primitives -----------------------------------------------------------------

let greyMode = false;

function toGrey(color: string): string {
  if (!color.startsWith("#") || color.length !== 7) return color;
  const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
  const l = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
  const mixed = Math.round(l * 0.75 + 200 * 0.25);
  const hex = mixed.toString(16).padStart(2, "0");
  return `#${hex}${hex}${hex}`;
}

export function rect(ctx: Ctx, color: string, x: number, y: number, w: number, h: number): void {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = greyMode ? toGrey(color) : color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

// --- 3x5 bitmap font ---------------------------------------------------------------

// Each glyph is 5 rows of 3 pixels ("#" = on).
const GLYPH_ROWS: Record<string, string[]> = {
  A: [".#.", "#.#", "###", "#.#", "#.#"], B: ["##.", "#.#", "##.", "#.#", "##."], C: [".##", "#..", "#..", "#..", ".##"],
  D: ["##.", "#.#", "#.#", "#.#", "##."], E: ["###", "#..", "##.", "#..", "###"], F: ["###", "#..", "##.", "#..", "#.."],
  G: [".##", "#..", "#.#", "#.#", ".##"], H: ["#.#", "#.#", "###", "#.#", "#.#"], I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["..#", "..#", "..#", "#.#", ".#."], K: ["#.#", "#.#", "##.", "#.#", "#.#"], L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#.#", "###", "###", "#.#", "#.#"], N: ["##.", "#.#", "#.#", "#.#", "#.#"], O: [".#.", "#.#", "#.#", "#.#", ".#."],
  P: ["##.", "#.#", "##.", "#..", "#.."], Q: [".#.", "#.#", "#.#", "##.", ".##"], R: ["##.", "#.#", "##.", "#.#", "#.#"],
  S: [".##", "#..", ".#.", "..#", "##."], T: ["###", ".#.", ".#.", ".#.", ".#."], U: ["#.#", "#.#", "#.#", "#.#", "###"],
  V: ["#.#", "#.#", "#.#", "#.#", ".#."], W: ["#.#", "#.#", "###", "###", "#.#"], X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."], Z: ["###", "..#", ".#.", "#..", "###"],
  "0": ["###", "#.#", "#.#", "#.#", "###"], "1": [".#.", "##.", ".#.", ".#.", "###"], "2": ["##.", "..#", ".#.", "#..", "###"],
  "3": ["##.", "..#", ".#.", "..#", "##."], "4": ["#.#", "#.#", "###", "..#", "..#"], "5": ["###", "#..", "##.", "..#", "##."],
  "6": [".##", "#..", "###", "#.#", "###"], "7": ["###", "..#", ".#.", ".#.", ".#."], "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "##."],
  ".": ["...", "...", "...", "...", ".#."], ",": ["...", "...", "...", ".#.", "#.."], ":": ["...", ".#.", "...", ".#.", "..."],
  ";": ["...", ".#.", "...", ".#.", "#.."], "!": [".#.", ".#.", ".#.", "...", ".#."], "?": ["##.", "..#", ".#.", "...", ".#."],
  "-": ["...", "...", "###", "...", "..."], _: ["...", "...", "...", "...", "###"], "/": ["..#", "..#", ".#.", "#..", "#.."],
  "\\": ["#..", "#..", ".#.", "..#", "..#"], "(": [".#.", "#..", "#..", "#..", ".#."], ")": [".#.", "..#", "..#", "..#", ".#."],
  "[": ["##.", "#..", "#..", "#..", "##."], "]": [".##", "..#", "..#", "..#", ".##"], "'": [".#.", ".#.", "...", "...", "..."],
  '"': ["#.#", "#.#", "...", "...", "..."], "=": ["...", "###", "...", "###", "..."], "+": ["...", ".#.", "###", ".#.", "..."],
  "*": ["...", "#.#", ".#.", "#.#", "..."], "<": ["..#", ".#.", "#..", ".#.", "..#"], ">": ["#..", ".#.", "..#", ".#.", "#.."],
  "#": ["#.#", "###", "#.#", "###", "#.#"], "%": ["#.#", "..#", ".#.", "#..", "#.#"], "|": [".#.", ".#.", ".#.", ".#.", ".#."],
  "&": [".#.", "#.#", ".#.", "#.#", ".##"], "@": [".#.", "#.#", "###", "#..", ".##"], " ": ["...", "...", "...", "...", "..."],
};
const GLYPHS: Record<string, string> = Object.fromEntries(Object.entries(GLYPH_ROWS).map(([k, rows]) => [k, rows.join("")]));

export const FONT_W = 4; // 3px glyph + 1px spacing
export const FONT_H = 5;

export function textWidth(text: string): number {
  return Math.max(0, text.length * FONT_W - 1);
}

export function drawText(ctx: Ctx, text: string, x: number, y: number, color: string = PALETTE.ink): void {
  let cx = Math.round(x);
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS["?"];
    for (let i = 0; i < 15; i++) if (glyph[i] === "#") rect(ctx, color, cx + (i % 3), y + Math.floor(i / 3), 1, 1);
    cx += FONT_W;
  }
}

// --- small icons ---------------------------------------------------------------------

export type IconKind = "coffee" | "warning" | "check" | "cross";

export function drawIcon(ctx: Ctx, kind: IconKind, x: number, y: number): void {
  const P = PALETTE;
  switch (kind) {
    case "coffee":
      rect(ctx, P.paper, x, y + 2, 5, 4);
      rect(ctx, P.ink, x, y + 6, 5, 1);
      rect(ctx, P.ink, x + 5, y + 3, 1, 1);
      rect(ctx, P.ink, x + 5, y + 5, 1, 1);
      rect(ctx, P.ink, x + 6, y + 4, 1, 1);
      rect(ctx, "#7b4a2e", x + 1, y + 2, 3, 1);
      rect(ctx, P.ink, x + 1, y, 1, 1);
      rect(ctx, P.ink, x + 3, y, 1, 1);
      break;
    case "warning":
      rect(ctx, P.mustard, x + 2, y, 1, 1);
      rect(ctx, P.mustard, x + 1, y + 1, 3, 2);
      rect(ctx, P.mustard, x, y + 3, 5, 3);
      rect(ctx, P.ink, x + 2, y + 1, 1, 3);
      rect(ctx, P.ink, x + 2, y + 5, 1, 1);
      break;
    case "check":
      rect(ctx, P.green, x, y, 7, 7);
      rect(ctx, P.paper, x + 1, y + 3, 1, 1);
      rect(ctx, P.paper, x + 2, y + 4, 1, 1);
      rect(ctx, P.paper, x + 3, y + 3, 1, 1);
      rect(ctx, P.paper, x + 4, y + 2, 1, 1);
      rect(ctx, P.paper, x + 5, y + 1, 1, 1);
      break;
    case "cross":
      rect(ctx, P.red, x, y, 7, 7);
      for (let i = 1; i < 6; i++) {
        rect(ctx, P.paper, x + i, y + i, 1, 1);
        rect(ctx, P.paper, x + 6 - i, y + i, 1, 1);
      }
      break;
  }
}

/** A speech bubble whose pointer tip is at (cx, bottom). Returns its top y. */
export function drawBubble(ctx: Ctx, text: string, cx: number, bottom: number, icon: "coffee" | "warning" | null | undefined, maxX: number): number {
  const iconW = icon ? 8 : 0;
  const w = textWidth(text) + 6 + iconW;
  const h = 11;
  const top = bottom - h - 3;
  let left = Math.round(cx - w / 2);
  left = Math.max(1, Math.min(maxX - w - 1, left));
  rect(ctx, PALETTE.ink, left, top, w, h);
  rect(ctx, PALETTE.bubble, left + 1, top + 1, w - 2, h - 2);
  // pointer
  rect(ctx, PALETTE.ink, cx - 2, top + h - 1, 5, 1);
  rect(ctx, PALETTE.bubble, cx - 1, top + h - 1, 3, 1);
  rect(ctx, PALETTE.ink, cx - 1, top + h, 3, 1);
  rect(ctx, PALETTE.bubble, cx, top + h, 1, 1);
  rect(ctx, PALETTE.ink, cx, top + h + 1, 1, 1);
  if (icon) drawIcon(ctx, icon, left + 3, top + 2);
  drawText(ctx, text, left + 3 + iconW, top + 3);
  return top;
}

// --- tiles ---------------------------------------------------------------------------

export function drawFloor(ctx: Ctx, kind: TileKind, tx: number, ty: number): void {
  const P = PALETTE;
  const x = tx * TILE, y = ty * TILE;
  switch (kind) {
    case "sage":
      rect(ctx, (tx + ty) % 2 ? P.sageAlt : P.sage, x, y, TILE, TILE);
      rect(ctx, P.sageGrout, x, y, TILE, 1);
      rect(ctx, P.sageGrout, x, y, 1, TILE);
      break;
    case "wood":
      for (let row = 0; row < 4; row++) {
        rect(ctx, row % 2 ? P.woodAlt : P.wood, x, y + row * 4, TILE, 4);
        rect(ctx, P.woodSeam, x, y + row * 4 + 3, TILE, 1);
        const seam = (row * 7 + tx * 5) % TILE;
        rect(ctx, P.woodSeam, x + seam, y + row * 4, 1, 3);
      }
      break;
    case "carpet":
      rect(ctx, P.carpet, x, y, TILE, TILE);
      for (let i = 0; i < 4; i++) rect(ctx, P.carpetDot, x + ((i * 5 + ty * 3) % 14) + 1, y + i * 4 + 1, 1, 1);
      break;
    case "kitchen":
      for (let i = 0; i < 4; i++) {
        const cx = i % 2, cy = Math.floor(i / 2);
        rect(ctx, (cx + cy) % 2 ? P.kitchenB : P.kitchenA, x + cx * 8, y + cy * 8, 8, 8);
      }
      break;
    default:
      rect(ctx, P.sage, x, y, TILE, TILE);
  }
}

export function drawWallCap(ctx: Ctx, tx: number, ty: number): void {
  const x = tx * TILE, y = ty * TILE;
  rect(ctx, PALETTE.wallCap, x, y, TILE, TILE);
  rect(ctx, PALETTE.wallCapHi, x, y, TILE, 2);
}

export function drawWallFace(ctx: Ctx, tx: number, ty: number): void {
  const x = tx * TILE, y = ty * TILE;
  rect(ctx, PALETTE.wallFace, x, y, TILE, TILE);
  rect(ctx, PALETTE.wallFaceShade, x, y, TILE, 2);
  rect(ctx, PALETTE.wallFaceShade, x + 15, y + 2, 1, 11);
  rect(ctx, PALETTE.baseboard, x, y + 13, TILE, 3);
}

export function drawDoorFrame(ctx: Ctx, tx: number, ty: number): void {
  const x = tx * TILE, y = ty * TILE;
  rect(ctx, PALETTE.baseboard, x, y, 1, TILE);
  rect(ctx, PALETTE.baseboard, x + 15, y, 1, TILE);
}

// --- wall items ------------------------------------------------------------------------

export function drawWindow(ctx: Ctx, x: number, y: number, wTiles: number, t: number): void {
  const P = PALETTE;
  const w = wTiles * TILE - 4;
  rect(ctx, P.frame, x + 2, y - 4, w, 15);
  rect(ctx, P.glass, x + 4, y - 2, w - 4, 11);
  // a cloud drifting by
  const cloudX = x + 4 + Math.floor(((t / 4000) * 6 + x) % (w - 8));
  rect(ctx, P.glassHi, cloudX, y + 1, 5, 2);
  rect(ctx, P.glassHi, cloudX + 1, y, 3, 1);
  rect(ctx, P.frame, x + 2 + Math.floor(w / 2), y - 2, 1, 11);
  rect(ctx, P.frame, x + 4, y + 3, w - 4, 1);
  rect(ctx, P.glassHi, x + 5, y - 1, 2, 2);
  rect(ctx, P.wallFaceShade, x + 1, y + 11, w + 2, 1);
}

export function drawCalendar(ctx: Ctx, x: number, y: number): void {
  const P = PALETTE;
  rect(ctx, P.ink, x + 3, y - 3, 10, 13);
  rect(ctx, P.paper, x + 4, y - 2, 8, 11);
  rect(ctx, P.red, x + 4, y - 2, 8, 3);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) rect(ctx, r === 1 && c === 1 ? P.red : "#b8ad9a", x + 5 + c * 2 + c, y + 2 + r * 2, 1, 1);
}

export function drawClock(ctx: Ctx, x: number, y: number, t: number): void {
  const P = PALETTE;
  rect(ctx, P.ink, x + 4, y - 3, 8, 8);
  rect(ctx, P.paper, x + 5, y - 2, 6, 6);
  rect(ctx, P.ink, x + 7, y - 1, 1, 3);
  const hand = Math.floor(t / 1000) % 4;
  const [hx, hy] = [[8, 1], [8, 2], [7, 3], [6, 2]][hand];
  rect(ctx, P.red, x + hx, y + hy, 1, 1);
}

export function drawPoster(ctx: Ctx, x: number, y: number): void {
  const P = PALETTE;
  rect(ctx, P.ink, x + 3, y - 4, 10, 14);
  rect(ctx, P.mustard, x + 4, y - 3, 8, 12);
  rect(ctx, P.red, x + 6, y - 1, 4, 4);
  rect(ctx, P.paper, x + 5, y + 5, 6, 1);
  rect(ctx, P.paper, x + 5, y + 7, 4, 1);
}

export function drawWhiteboard(ctx: Ctx, x: number, y: number, wTiles: number, lines: number, t: number): void {
  const P = PALETTE;
  const w = wTiles * TILE - 6;
  rect(ctx, "#8f8a82", x + 3, y - 5, w, 17);
  rect(ctx, P.paper, x + 4, y - 4, w - 2, 14);
  rect(ctx, "#8f8a82", x + 6, y + 12, w - 6, 1);
  rect(ctx, P.red, x + 10, y + 11, 3, 1);
  rect(ctx, P.blue, x + 15, y + 11, 3, 1);
  drawText(ctx, "PLAN", x + 6, y - 3, P.red);
  const shown = Math.min(lines, 5);
  for (let i = 0; i < shown; i++) {
    const row = y + 3 + (i % 3) * 3;
    const col = x + 6 + Math.floor(i / 3) * 32;
    rect(ctx, P.blue, col, row, 2, 1);
    const length = 10 + ((i * 7) % 12);
    // The newest line is still being written.
    const drawn = i === shown - 1 ? Math.min(length, 4 + Math.floor((t / 120) % (length - 3))) : length;
    rect(ctx, P.ink, col + 4, row, drawn, 1);
  }
}

export interface MonitorView {
  status: "idle" | "pass" | "fail";
  passed: number | null;
  failed: number | null;
}

export function drawTestMonitor(ctx: Ctx, x: number, y: number, wTiles: number, m: MonitorView, t: number): void {
  const P = PALETTE;
  const w = wTiles * TILE - 2;
  rect(ctx, P.ink, x + 1, y - 7, w, 20);
  const bg = m.status === "pass" ? "#2f5e33" : m.status === "fail" ? "#6e2a22" : "#22303a";
  rect(ctx, bg, x + 3, y - 5, w - 4, 16);
  rect(ctx, P.metalDark, x + w / 2 - 2, y + 13, 6, 2);
  const fg = m.status === "pass" ? P.greenHi : m.status === "fail" ? P.redHi : "#7f97a6";
  if (m.status === "idle") {
    drawText(ctx, "TESTS", x + 5, y - 3, fg);
    if (Math.floor(t / 500) % 2) rect(ctx, fg, x + 5, y + 4, 3, 5);
    return;
  }
  const line1 = m.status === "pass" ? "PASS" : `${m.failed ?? "?"} FAIL`;
  const line2 = m.passed != null ? `${m.passed} OK` : "";
  drawText(ctx, line1, x + 5, y - 3, fg);
  drawText(ctx, line2, x + 5, y + 4, fg);
  // a status lamp
  rect(ctx, fg, x + w - 6, y - 3, 3, 3);
}

// --- furniture ---------------------------------------------------------------------------

export function drawShadow(ctx: Ctx, x: number, y: number, w: number): void {
  rect(ctx, PALETTE.deskShadow, x + 1, y, w - 2, 2);
}

export function drawDesk(ctx: Ctx, x: number, y: number, wTiles: number, screenOn: boolean, t: number): void {
  const P = PALETTE;
  const w = wTiles * TILE;
  drawShadow(ctx, x, y + 14, w);
  rect(ctx, P.deskFront, x, y + 2, w, 12);
  rect(ctx, P.deskTop, x, y, w, 8);
  rect(ctx, P.deskTopHi, x, y, w, 1);
  rect(ctx, "#6e4529", x + 1, y + 13, 2, 2);
  rect(ctx, "#6e4529", x + w - 3, y + 13, 2, 2);
  rect(ctx, "#a06c42", x + 4, y + 9, w - 8, 1);
  // monitor (seen from behind) on the left tile, screen glow on its top edge
  rect(ctx, P.metalDark, x + 3, y - 8, 12, 10);
  rect(ctx, P.metal, x + 4, y - 7, 10, 8);
  rect(ctx, screenOn ? (Math.floor(t / 300) % 2 ? P.screen : "#8cc4bd") : P.metalDark, x + 4, y - 8, 10, 1);
  rect(ctx, P.metalDark, x + 8, y + 2, 2, 2);
  // keyboard and mug
  rect(ctx, "#e6e1d6", x + 18, y + 2, 12, 4);
  rect(ctx, "#b9b2a3", x + 18, y + 5, 12, 1);
  if (wTiles > 2) {
    rect(ctx, P.paper, x + w - 9, y + 1, 4, 4);
    rect(ctx, P.red, x + w - 9, y + 2, 4, 1);
  }
}

export function drawPlant(ctx: Ctx, x: number, y: number, t: number): void {
  const P = PALETTE;
  const sway = Math.floor(t / 900 + x) % 2;
  drawShadow(ctx, x + 2, y + 14, 12);
  rect(ctx, P.potDark, x + 4, y + 9, 8, 6);
  rect(ctx, P.pot, x + 4, y + 9, 8, 2);
  rect(ctx, P.pot, x + 5, y + 11, 6, 3);
  rect(ctx, P.leafDark, x + 3, y + 3, 10, 6);
  rect(ctx, P.leaf, x + 4 + sway, y - 1, 6, 8);
  rect(ctx, P.leaf, x + 2, y + 4, 4, 3);
  rect(ctx, P.leaf, x + 10, y + 4, 4, 3);
  rect(ctx, P.leafLight, x + 6 + sway, y, 2, 4);
  rect(ctx, P.leafLight, x + 3, y + 5, 2, 1);
}

export function drawBookshelf(ctx: Ctx, x: number, y: number, wTiles: number): void {
  const P = PALETTE;
  const w = wTiles * TILE;
  const books = ["#c0583f", "#4f7cac", "#d9a441", "#5f9a57", "#8e6bb0", "#e8dcc2"];
  drawShadow(ctx, x, y + 14, w);
  rect(ctx, "#7a5134", x + 1, y - 10, w - 2, 25);
  for (let shelf = 0; shelf < 2; shelf++) {
    const sy = y - 8 + shelf * 11;
    rect(ctx, "#4e321f", x + 3, sy, w - 6, 9);
    for (let b = 0; b < (w - 8) / 3; b++) {
      const h = 6 + ((b + shelf) % 3);
      rect(ctx, books[(b * 5 + shelf * 2) % books.length], x + 4 + b * 3, sy + 9 - h, 2, h);
    }
  }
}

export function drawRug(ctx: Ctx, x: number, y: number, wTiles: number, hTiles: number): void {
  const w = wTiles * TILE, h = hTiles * TILE;
  rect(ctx, "#6f8a7e", x + 1, y + 1, w - 2, h - 2);
  rect(ctx, "#86a395", x + 3, y + 3, w - 6, h - 6);
  rect(ctx, "#e3b07a", x + 6, y + 6, w - 12, 1);
  rect(ctx, "#e3b07a", x + 6, y + h - 7, w - 12, 1);
}

export function drawMeetingTable(ctx: Ctx, x: number, y: number, wTiles: number, hTiles: number): void {
  const P = PALETTE;
  const w = wTiles * TILE, h = hTiles * TILE;
  drawShadow(ctx, x, y + h - 2, w);
  rect(ctx, P.deskFront, x + 1, y + 2, w - 2, h - 4);
  rect(ctx, P.deskTop, x + 1, y, w - 2, h - 8);
  rect(ctx, P.deskTopHi, x + 2, y, w - 4, 1);
  // papers and a laptop
  rect(ctx, P.paper, x + 10, y + 6, 8, 6);
  rect(ctx, P.paper, x + 40, y + 10, 7, 5);
  rect(ctx, P.metal, x + 56, y + 5, 12, 8);
  rect(ctx, P.screen, x + 57, y + 6, 10, 5);
}

export function drawChair(ctx: Ctx, x: number, y: number, facing: Facing = "down"): void {
  const seat = "#5e6f7a", back = "#46535c";
  rect(ctx, seat, x + 4, y + 6, 8, 6);
  if (facing === "right") rect(ctx, back, x + 3, y + 2, 2, 10);
  else if (facing === "left") rect(ctx, back, x + 11, y + 2, 2, 10);
  else rect(ctx, back, x + 4, y + 2, 8, 3);
  rect(ctx, PALETTE.metalDark, x + 7, y + 12, 2, 3);
}

export function drawCounter(ctx: Ctx, x: number, y: number, wTiles: number, steaming: boolean, t: number): void {
  const P = PALETTE;
  const w = wTiles * TILE;
  drawShadow(ctx, x, y + 14, w);
  rect(ctx, "#a88d6a", x, y + 3, w, 12);
  rect(ctx, "#ddd0b4", x, y - 2, w, 6);
  rect(ctx, "#efe6d2", x, y - 2, w, 1);
  for (let i = 0; i < wTiles; i++) {
    rect(ctx, "#94795a", x + i * TILE + 1, y + 5, TILE - 2, 9);
    rect(ctx, "#d7c6a5", x + i * TILE + 7, y + 8, 2, 1);
  }
  // coffee machine on the second tile
  const cx = x + TILE + 2;
  rect(ctx, P.ink, cx, y - 12, 12, 13);
  rect(ctx, "#5a4d49", cx + 1, y - 11, 10, 11);
  rect(ctx, "#2b2523", cx + 3, y - 5, 6, 4);
  rect(ctx, P.paper, cx + 4, y - 3, 4, 3);
  rect(ctx, Math.floor(t / 400) % 2 ? "#e05a47" : "#7b2e24", cx + 2, y - 10, 2, 2);
  rect(ctx, "#8a7a74", cx + 6, y - 10, 4, 2);
  if (steaming) {
    const s = Math.floor(t / 250) % 3;
    rect(ctx, P.steam, cx + 5 + (s === 1 ? 1 : 0), y - 16 - s, 1, 3);
    rect(ctx, P.steam, cx + 7 - (s === 2 ? 1 : 0), y - 18 + s, 1, 3);
  }
  // sink on the fourth tile
  const sx = x + 3 * TILE + 2;
  rect(ctx, "#9aa3a6", sx, y - 1, 12, 4);
  rect(ctx, "#c7cfd1", sx + 1, y, 10, 2);
  rect(ctx, P.metal, sx + 5, y - 5, 2, 4);
  rect(ctx, P.metal, sx + 5, y - 5, 4, 1);
}

export function drawFridge(ctx: Ctx, x: number, y: number): void {
  drawShadow(ctx, x, y + 14, TILE);
  rect(ctx, "#b8b2a4", x + 1, y - 12, 14, 27);
  rect(ctx, "#ece8dd", x + 2, y - 11, 12, 25);
  rect(ctx, "#b8b2a4", x + 2, y - 2, 12, 1);
  rect(ctx, "#8b8578", x + 11, y - 8, 1, 4);
  rect(ctx, "#8b8578", x + 11, y + 2, 1, 5);
  rect(ctx, PALETTE.red, x + 4, y - 9, 2, 2);
  rect(ctx, PALETTE.blue, x + 7, y - 8, 2, 2);
}

export function drawKitchenTable(ctx: Ctx, x: number, y: number, wTiles: number): void {
  const w = wTiles * TILE;
  drawShadow(ctx, x + 2, y + 14, w - 4);
  rect(ctx, "#8a5a37", x + 3, y + 4, w - 6, 9);
  rect(ctx, "#c79262", x + 2, y + 1, w - 4, 7);
  rect(ctx, "#d9a87a", x + 4, y + 1, w - 8, 1);
  rect(ctx, PALETTE.paper, x + 8, y + 2, 4, 3);
  rect(ctx, "#7b4a2e", x + 9, y + 2, 2, 1);
  rect(ctx, PALETTE.leaf, x + 20, y, 3, 3);
}

export function drawMergeTable(ctx: Ctx, x: number, y: number, wTiles: number, hTiles: number, active: boolean, t: number): void {
  const P = PALETTE;
  const w = wTiles * TILE, h = hTiles * TILE;
  drawShadow(ctx, x, y + h - 2, w);
  rect(ctx, "#6f4a30", x + 1, y + 3, w - 2, h - 5);
  rect(ctx, "#9c6c45", x + 1, y, w - 2, h - 9);
  rect(ctx, "#b58258", x + 2, y, w - 4, 1);
  // a merge diagram: two branches joining
  const lx = x + 16, ly = y + 6;
  const glow = active && Math.floor(t / 300) % 2 ? P.greenHi : P.paper;
  rect(ctx, P.paper, lx - 4, ly - 2, 40, 16);
  rect(ctx, P.blue, lx, ly + 2, 12, 1);
  rect(ctx, P.mustard, lx, ly + 9, 12, 1);
  rect(ctx, P.blue, lx + 12, ly + 3, 1, 2);
  rect(ctx, P.mustard, lx + 12, ly + 7, 1, 2);
  rect(ctx, P.green, lx + 13, ly + 5, 16, 2);
  rect(ctx, glow, lx + 26, ly + 4, 4, 4);
  rect(ctx, P.ink, lx - 2, ly + 1, 3, 3);
  rect(ctx, P.ink, lx - 2, ly + 8, 3, 3);
}

export function drawCooler(ctx: Ctx, x: number, y: number): void {
  drawShadow(ctx, x + 3, y + 14, 10);
  rect(ctx, "#d9d4c8", x + 4, y + 1, 8, 14);
  rect(ctx, "#b8b2a4", x + 4, y + 8, 8, 1);
  rect(ctx, "#8fc1d6", x + 5, y - 9, 6, 10);
  rect(ctx, "#c6e3ee", x + 6, y - 8, 2, 6);
  rect(ctx, PALETTE.blue, x + 6, y + 4, 1, 2);
  rect(ctx, PALETTE.red, x + 9, y + 4, 1, 2);
}

export function drawSofa(ctx: Ctx, x: number, y: number, wTiles: number): void {
  const w = wTiles * TILE;
  drawShadow(ctx, x, y + 14, w);
  rect(ctx, "#4f6f6a", x, y - 4, w, 8);
  rect(ctx, "#5f8580", x + 1, y + 2, w - 2, 9);
  rect(ctx, "#4f6f6a", x, y + 2, 3, 12);
  rect(ctx, "#4f6f6a", x + w - 3, y + 2, 3, 12);
  rect(ctx, "#3f5a56", x + 3, y + 11, w - 6, 3);
  rect(ctx, PALETTE.mustard, x + 6, y, 6, 5);
}

export function drawDivider(ctx: Ctx, x: number, y: number, hTiles: number): void {
  const h = hTiles * TILE;
  rect(ctx, PALETTE.wallCap, x + 5, y - 6, 6, h + 6);
  rect(ctx, PALETTE.wallCapHi, x + 5, y - 6, 6, 1);
  rect(ctx, PALETTE.wallFaceShade, x + 6, y - 5, 4, h + 4);
  rect(ctx, PALETTE.wallFace, x + 6, y - 5, 2, h + 4);
}

// --- characters ----------------------------------------------------------------------------

export interface Look {
  hair: string;
  skin: string;
  shirt: string;
  shirtDark: string;
  pants: string;
  shoes: string;
  accessory: "tie" | "headphones" | "glasses" | "cap";
  accent: string;
}

export const LOOKS: Record<CrewAgent, Look> = {
  lead: { hair: "#4a2f22", skin: "#e8b48f", shirt: "#c0583f", shirtDark: "#97412e", pants: "#3f3a4a", shoes: "#2b2523", accessory: "tie", accent: "#d9a441" },
  tester: { hair: "#e2b04f", skin: "#f3cdae", shirt: "#5f9a57", shirtDark: "#477a42", pants: "#5b4a3a", shoes: "#2b2523", accessory: "cap", accent: "#d9a441" },
  coder: { hair: "#262a3d", skin: "#b07a52", shirt: "#4f7cac", shirtDark: "#3a5f87", pants: "#33313b", shoes: "#e8e1d4", accessory: "headphones", accent: "#c0583f" },
  reviewer: { hair: "#8a4b6f", skin: "#d49b74", shirt: "#8e6bb0", shirtDark: "#6d4f8b", pants: "#4a4152", shoes: "#2b2523", accessory: "glasses", accent: "#2b2523" },
};

export type Pose = "stand" | "walk" | "sit" | "type" | "write";

interface Part {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  outline?: boolean;
}

function characterParts(look: Look, facing: Facing, pose: Pose, frame: number): Part[] {
  const parts: Part[] = [];
  const add = (x: number, y: number, w: number, h: number, color: string, outline = true) => parts.push({ x, y, w, h, color, outline });
  const seated = pose === "sit" || pose === "type";
  const bob = pose === "walk" ? (frame % 2 ? -1 : 0) : pose === "stand" || pose === "sit" ? (frame % 2 ? 1 : 0) : 0;
  const side = facing === "left" || facing === "right";

  // legs (hidden behind the desk when seated)
  if (!seated) {
    const lift = (leg: 0 | 1) => (pose === "walk" && ((frame === 1 && leg === 0) || (frame === 3 && leg === 1)) ? 1 : 0);
    const legsX: [number, number] = side ? [6, 8] : [5, 9];
    for (const leg of [0, 1] as const) {
      const lx = legsX[leg] + (side && pose === "walk" ? (frame === 1 ? (leg ? 1 : -1) : frame === 3 ? (leg ? -1 : 1) : 0) : 0);
      add(lx, 12, 2, 2 - lift(leg), look.pants);
      add(lx, 14 - lift(leg), 2, 1, look.shoes);
    }
  }

  const by = bob;
  // torso and arms
  if (side) {
    add(5, 7 + by, 6, 5, look.shirt);
    const swing = pose === "walk" ? (frame === 1 ? -1 : frame === 3 ? 1 : 0) : 0;
    add(7 + swing, 8 + by, 2, 3, look.shirtDark);
    add(7 + swing, 11 + by, 2, 1, look.skin);
  } else {
    add(4, 7 + by, 8, 5, look.shirt);
    if (pose === "type") {
      const tap = frame % 2;
      add(3, 8 + by, 1, 3, look.shirtDark);
      add(12, 8 + by, 1, 3, look.shirtDark);
      add(4, 10 + by + tap, 2, 1, look.skin);
      add(10, 11 + by - tap, 2, 1, look.skin);
    } else if (pose === "write") {
      add(3, 8 + by, 1, 4, look.shirtDark);
      add(3, 12 + by, 1, 1, look.skin);
      const reach = frame % 2;
      add(12, 3 + reach, 1, 6, look.shirtDark);
      add(12, 2 + reach, 1, 1, look.skin);
    } else {
      const swing = pose === "walk" ? (frame === 1 ? 1 : frame === 3 ? -1 : 0) : 0;
      add(3, 8 + by + swing, 1, 3, look.shirtDark);
      add(12, 8 + by - swing, 1, 3, look.shirtDark);
      add(3, 11 + by + swing, 1, 1, look.skin);
      add(12, 11 + by - swing, 1, 1, look.skin);
    }
    if (look.accessory === "tie" && facing === "down") {
      add(7, 7 + by, 2, 1, look.shirtDark, false);
      add(7, 8 + by, 2, 3, look.accent, false);
    }
  }

  // head
  const hy = by;
  if (facing === "up") {
    add(4, hy, 8, 7, look.hair);
    add(5, 6 + hy, 6, 1, look.skin, false);
  } else if (side) {
    add(4, hy, 8, 7, look.skin);
    add(4, hy, 8, 3, look.hair);
    add(4, 3 + hy, 3, 3, look.hair, false);
    add(9, 4 + hy, 1, 2, look.accent === "#2b2523" ? look.accent : PALETTE.ink, false);
  } else {
    add(4, hy, 8, 7, look.skin);
    add(4, hy, 8, 3, look.hair);
    add(4, 3 + hy, 1, 2, look.hair, false);
    add(11, 3 + hy, 1, 2, look.hair, false);
    add(6, 4 + hy, 1, 2, PALETTE.ink, false);
    add(9, 4 + hy, 1, 2, PALETTE.ink, false);
    add(5, 6 + hy, 1, 1, "#e59a86", false);
    add(10, 6 + hy, 1, 1, "#e59a86", false);
  }

  // accessories on the head
  if (look.accessory === "cap") {
    add(4, hy - 1, 8, 2, look.accent, false);
    if (facing === "down") add(4, 1 + hy, 9, 1, "#b8862f", false);
    else if (facing === "right") add(10, 1 + hy, 4, 1, "#b8862f", false);
    else if (facing === "left") add(2, 1 + hy, 4, 1, "#b8862f", false);
  } else if (look.accessory === "headphones") {
    add(4, hy - 1, 8, 1, "#3b3b42", false);
    if (facing === "down" || facing === "up") {
      add(3, 2 + hy, 1, 4, look.accent, false);
      add(12, 2 + hy, 1, 4, look.accent, false);
    } else {
      add(facing === "right" ? 6 : 9, 2 + hy, 2, 3, look.accent, false);
    }
  } else if (look.accessory === "glasses" && facing === "down") {
    add(5, 4 + hy, 3, 1, PALETTE.ink, false);
    add(8, 4 + hy, 3, 1, PALETTE.ink, false);
    add(6, 5 + hy, 1, 1, "#cfe3e8", false);
    add(9, 5 + hy, 1, 1, "#cfe3e8", false);
  }

  if (facing === "left") for (const p of parts) p.x = 16 - p.x - p.w;
  return parts;
}

/**
 * Draw a character into the 16x16 cell at (x, y); feet at y+15. Seated
 * characters sit 3px lower so the desk drawn after them covers their legs.
 */
export function drawCharacter(
  ctx: Ctx,
  agent: CrewAgent,
  x: number,
  y: number,
  facing: Facing,
  pose: Pose,
  frame: number,
  grey = false,
): void {
  const parts = characterParts(LOOKS[agent], facing, pose, frame);
  const oy = pose === "sit" || pose === "type" ? y + 3 : y;
  greyMode = grey;
  if (pose !== "sit" && pose !== "type") rect(ctx, "rgba(43,37,35,0.22)", x + 3, oy + 14, 10, 2);
  for (const p of parts) if (p.outline !== false) rect(ctx, PALETTE.ink, x + p.x - 1, oy + p.y - 1, p.w + 2, p.h + 2);
  for (const p of parts) rect(ctx, p.color, x + p.x, oy + p.y, p.w, p.h);
  greyMode = false;
}

/** Head-and-shoulders portrait for the agent cards (16x13 px). */
export function drawPortrait(ctx: Ctx, agent: CrewAgent, frame: number, grey = false): void {
  ctx.clearRect(0, 0, 16, 16);
  greyMode = grey;
  rect(ctx, "#efe3c9", 0, 0, 16, 16);
  rect(ctx, "#e3d4b4", 0, 12, 16, 4);
  greyMode = false;
  drawCharacter(ctx, agent, 0, 3, "down", "sit", frame, grey);
}

// --- effects ---------------------------------------------------------------------------------

const CONFETTI_COLORS = ["#c0583f", "#d9a441", "#5f9a57", "#4f7cac", "#8e6bb0", "#f08a74"];

export function drawConfetti(ctx: Ctx, width: number, height: number, seconds: number): void {
  const fade = seconds > 9 ? Math.max(0, 1 - (seconds - 9) / 3) : 1;
  if (fade <= 0) return;
  for (let i = 0; i < 90; i++) {
    const seed = Math.sin(i * 12.9898) * 43758.5453;
    const r = seed - Math.floor(seed);
    const speed = 30 + r * 40;
    const x0 = (i * 53.7 + r * 97) % width;
    const y = ((seconds * speed + r * height * 1.5 - 20) % (height + 30)) - 10;
    // pieces only fall in during the first pass, then keep looping until faded
    if (seconds * speed + r * height * 1.5 - 20 < 0) continue;
    const x = x0 + Math.sin(seconds * 3 + i) * 5;
    if (r > 1 - fade || fade === 1) {
      rect(ctx, CONFETTI_COLORS[i % CONFETTI_COLORS.length], x, y, Math.floor(seconds * 6 + i) % 2 ? 2 : 1, 2);
    }
  }
}

export function drawRainCloud(ctx: Ctx, cx: number, top: number, seconds: number): void {
  const x = Math.round(cx - 12 + Math.sin(seconds * 1.5) * 2);
  rect(ctx, "#5d6670", x + 2, top + 3, 22, 7);
  rect(ctx, "#77808a", x + 5, top, 9, 6);
  rect(ctx, "#77808a", x + 12, top + 1, 9, 6);
  rect(ctx, "#8e979f", x + 6, top + 1, 4, 2);
  for (let i = 0; i < 5; i++) {
    const dy = (seconds * 40 + i * 7) % 16;
    rect(ctx, "#7fa6c9", x + 4 + i * 4, top + 11 + dy, 1, 3);
  }
}
