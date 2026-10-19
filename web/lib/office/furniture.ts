// Office furniture, drawn from rectangles. Each function draws one piece at
// its tile position; tall pieces rise above their tile (a bookshelf stands
// against the wall behind it). `FurnitureState` carries the few things that
// move: monitors glow while their agent works, the coffee machine steams
// while someone uses it, the server rack's LEDs blink.

import type { CrewAgent } from "../types";
import { TILE, type Furniture } from "./layout";
import { AGENT_COLORS, PALETTE, box, drawText, glow, noise, rect, softShadow, textWidth } from "./sprites";

type Ctx = CanvasRenderingContext2D;
const P = PALETTE;

export interface FurnitureState {
  t: number;
  // a desk owner's monitor: on (and how busy), or null when off
  screen: (owner: CrewAgent) => { busy: boolean } | null;
  coffeeInUse: boolean;
  mergeActive: boolean;
}

const MUGS = ["#c0583f", "#f4efe6", "#4f7cac", "#d9a441", "#5f9a57", "#8e6bb0"];
const NAMEPLATE: Record<CrewAgent, string> = { lead: "LEAD", tester: "TESTER", coder: "CODER", reviewer: "REVIEWER" };

export function drawFurniture(ctx: Ctx, item: Furniture, s: FurnitureState): void {
  const x = item.x * TILE, y = item.y * TILE;
  const w = item.w * TILE, h = item.h * TILE;
  const v = item.variant ?? 0;
  switch (item.kind) {
    case "desk":
      return drawDesk(ctx, x, y, w, v, item.owner, s);
    case "chair":
      return drawOfficeChair(ctx, x, y, v);
    case "visitorChair":
      return drawVisitorChair(ctx, x, y, item.facing ?? "down");
    case "plant":
      return drawPlant(ctx, x, y, v, s.t);
    case "bookshelf":
      return drawBookshelf(ctx, x, y, w, v);
    case "filingCabinet":
      return drawFilingCabinet(ctx, x, y, w, v);
    case "meetingTable":
      return drawMeetingTable(ctx, x, y, w, h);
    case "counter":
      return drawCounter(ctx, x, y, w, s);
    case "fridge":
      return drawFridge(ctx, x, y);
    case "kitchenTable":
      return drawKitchenTable(ctx, x, y, w);
    case "mergeTable":
      return drawMergeTable(ctx, x, y, w, h, s);
    case "serverRack":
      return drawServerRack(ctx, x, y, h, s.t);
    case "cooler":
      return drawCooler(ctx, x, y, s.t);
    case "printer":
      return drawPrinter(ctx, x, y, s.t);
    case "sofa":
      return drawSofa(ctx, x, y, w);
    case "coffeeTable":
      return drawCoffeeTable(ctx, x, y, w);
    case "armchair":
      return drawArmchair(ctx, x, y);
    case "floorLamp":
      return drawFloorLamp(ctx, x, y);
    case "rug":
      return drawRug(ctx, x, y, w, h);
    case "glassPartition":
      return drawGlassPartition(ctx, x, y, w, s.t);
    case "bin":
      return drawBin(ctx, x, y, v);
  }
}

/** Where a piece sorts against the characters (its front edge). */
export function sortYOf(item: Furniture): number {
  if (item.kind === "rug") return -1;
  // seats go under whoever sits on them
  if (item.kind === "chair" || item.kind === "sofa" || item.kind === "visitorChair" || item.kind === "armchair") return item.y * TILE + 8;
  return (item.y + item.h) * TILE - 1;
}

// --- desks and chairs ------------------------------------------------------------------

function drawDesk(ctx: Ctx, x: number, y: number, w: number, v: number, owner: CrewAgent | undefined, s: FurnitureState): void {
  const screen = owner ? s.screen(owner) : null;
  // shadow and legs
  rect(ctx, P.shadow, x + 2, y + 13, w - 1, 4);
  rect(ctx, P.woodDeep, x + 1, y + 10, 3, 6);
  rect(ctx, P.woodDeep, x + w - 4, y + 10, 3, 6);
  // front panel with a drawer unit under the monitor
  rect(ctx, P.woodDark, x, y + 4, w, 9);
  rect(ctx, "#7a4e2f", x, y + 12, w, 1);
  if (!owner) {
    box(ctx, "#9a6a42", x + 2, y + 5, 13, 9, P.woodDeep);
    rect(ctx, "#d9b48a", x + 7, y + 8, 3, 1);
    rect(ctx, "#d9b48a", x + 7, y + 11, 3, 1);
  }
  // top surface
  rect(ctx, P.ink, x - 1, y - 7, w + 2, 12);
  rect(ctx, P.wood, x, y - 6, w, 10);
  rect(ctx, P.woodHi, x, y - 6, w, 1);
  rect(ctx, "#d6a575", x, y + 3, w, 1);
  // cable down to a floor box
  rect(ctx, "#2b2523", x + w - 7, y + 13, 1, 4);
  rect(ctx, "#2b2523", x + w - 7, y + 16, 5, 1);
  rect(ctx, "#6b6b73", x + w - 3, y + 15, 3, 2);

  // monitor, turned towards the chair: its back, and the screen's edge on the right
  const glowColor = owner ? AGENT_COLORS[owner] : "#79b3ad";
  if (screen) {
    const flicker = screen.busy ? 0.05 * Math.sin(s.t / 90) + (noise(Math.floor(s.t / 120), x) > 0.85 ? 0.08 : 0) : 0;
    glow(ctx, x + 17, y - 12, 30, glowColor, 0.5 + flicker);
    glow(ctx, x + 22, y - 2, 14, "#e8f6ff", 0.18 + flicker); // light on the keyboard
  }
  rect(ctx, P.ink, x + 2, y - 21, 15, 15);
  rect(ctx, P.metal, x + 3, y - 20, 11, 13);
  rect(ctx, P.metalLight, x + 3, y - 20, 11, 1);
  rect(ctx, "#4a4b53", x + 5, y - 16, 7, 1);
  rect(ctx, "#4a4b53", x + 5, y - 14, 7, 1);
  const lit = screen ? (screen.busy && Math.floor(s.t / 180) % 3 === 0 ? "#e8f6ff" : lighten(glowColor)) : "#26282e";
  rect(ctx, lit, x + 14, y - 20, 2, 13);
  rect(ctx, P.metalDark, x + 8, y - 7, 3, 3);
  rect(ctx, P.metalDark, x + 6, y - 5, 7, 2);
  // keyboard and mouse in front of the chair
  rect(ctx, P.ink, x + 18, y - 3, 13, 5);
  rect(ctx, "#e6e1d6", x + 19, y - 2, 11, 3);
  for (let i = 0; i < 5; i++) rect(ctx, "#b9b2a3", x + 20 + i * 2, y - 1, 1, 1);
  rect(ctx, P.ink, x + 33, y - 2, 3, 4);
  rect(ctx, "#e6e1d6", x + 34, y - 1, 1, 2);
  // papers and a mug on the right
  rect(ctx, P.paperShade, x + w - 15, y - 4, 7, 6);
  rect(ctx, P.paper, x + w - 16, y - 5, 7, 6);
  rect(ctx, "#b8ad9a", x + w - 15, y - 3, 5, 1);
  rect(ctx, "#b8ad9a", x + w - 15, y - 1, 4, 1);
  const mug = MUGS[v % MUGS.length];
  rect(ctx, P.ink, x + w - 7, y - 5, 5, 6);
  rect(ctx, mug, x + w - 6, y - 4, 3, 4);
  rect(ctx, P.ink, x + w - 2, y - 3, 1, 2);
  if (v % 3 === 0) {
    // desk lamp, switched on
    glow(ctx, x + w - 10, y - 8, 14, "#ffd98a", 0.25);
    rect(ctx, P.ink, x + w - 12, y - 5, 5, 2);
    rect(ctx, P.ink, x + w - 10, y - 14, 1, 10);
    rect(ctx, P.ink, x + w - 14, y - 17, 7, 4);
    rect(ctx, P.mustard, x + w - 13, y - 16, 5, 2);
  } else if (v % 3 === 1) {
    // a little succulent
    rect(ctx, P.ink, x + w - 13, y - 9, 6, 5);
    rect(ctx, "#e8dcc2", x + w - 12, y - 8, 4, 3);
    rect(ctx, P.leaf, x + w - 12, y - 12, 4, 3);
    rect(ctx, P.leafLight, x + w - 11, y - 13, 1, 2);
  }
  if (owner) {
    // nameplate on the front
    const text = NAMEPLATE[owner];
    const tw = textWidth(text) + 6;
    const left = Math.round(x + (w - tw) / 2);
    box(ctx, "#3f4a52", left, y + 5, tw, 8, P.ink);
    drawText(ctx, text, left + 3, y + 7, "#f4ead5");
  }
}

function lighten(hex: string): string {
  const c = (i: number) => Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.5 + 128)).toString(16).padStart(2, "0");
  return `#${c(1)}${c(3)}${c(5)}`;
}

const CHAIR_FABRICS = [
  ["#2f7f86", "#4aa3a8", "#24646a"],
  ["#b5523d", "#d4735c", "#8f3f2e"],
  ["#3f6fa8", "#5f8fc6", "#30578a"],
];

function drawOfficeChair(ctx: Ctx, x: number, y: number, v: number): void {
  const [fabric, hi, dark] = CHAIR_FABRICS[v % CHAIR_FABRICS.length];
  softShadow(ctx, x + 8, y + 15, 14, 0.16);
  // star base on wheels, and the gas lift
  rect(ctx, P.ink, x + 2, y + 12, 12, 2);
  rect(ctx, P.metalLight, x + 3, y + 12, 10, 1);
  rect(ctx, P.ink, x + 1, y + 14, 3, 2);
  rect(ctx, P.ink, x + 12, y + 14, 3, 2);
  rect(ctx, P.ink, x + 7, y + 14, 2, 2);
  rect(ctx, P.ink, x + 6, y + 8, 4, 5);
  rect(ctx, P.metalLight, x + 7, y + 8, 2, 4);
  // seat cushion with armrests
  rect(ctx, P.ink, x + 1, y + 2, 14, 8);
  rect(ctx, fabric, x + 2, y + 3, 12, 6);
  rect(ctx, hi, x + 3, y + 3, 10, 1);
  rect(ctx, dark, x + 2, y + 7, 12, 2);
  rect(ctx, P.ink, x, y, 2, 6);
  rect(ctx, P.ink, x + 14, y, 2, 6);
  // backrest: shorter than a monitor, rounded, with a seam
  rect(ctx, P.ink, x + 3, y - 7, 10, 10);
  rect(ctx, P.ink, x + 2, y - 6, 12, 8);
  rect(ctx, fabric, x + 3, y - 6, 10, 8);
  rect(ctx, fabric, x + 4, y - 7 + 1, 8, 1);
  rect(ctx, hi, x + 4, y - 5, 8, 1);
  rect(ctx, dark, x + 3, y, 10, 2);
}

function drawVisitorChair(ctx: Ctx, x: number, y: number, facing: string): void {
  const wood = "#8a5a37", seat = "#a2645a";
  softShadow(ctx, x + 8, y + 14, 12, 0.14);
  rect(ctx, P.woodDeep, x + 4, y + 8, 2, 6);
  rect(ctx, P.woodDeep, x + 10, y + 8, 2, 6);
  if (facing === "down") {
    box(ctx, wood, x + 3, y - 5, 10, 8);
    rect(ctx, "#a06c42", x + 4, y - 4, 8, 1);
    box(ctx, seat, x + 3, y + 2, 10, 7);
  } else if (facing === "up") {
    box(ctx, seat, x + 3, y, 10, 6);
    box(ctx, wood, x + 3, y + 4, 10, 8);
    rect(ctx, "#a06c42", x + 4, y + 5, 8, 1);
  } else {
    box(ctx, seat, x + 3, y + 2, 10, 7);
    const bx = facing === "right" ? x + 2 : x + 11;
    box(ctx, wood, bx, y - 5, 3, 13);
  }
}

// --- plants ----------------------------------------------------------------------------

function drawPlant(ctx: Ctx, x: number, y: number, v: number, t: number): void {
  const sway = Math.floor(t / 1100 + x * 0.1) % 2;
  softShadow(ctx, x + 8, y + 15, 12, 0.18);
  const pot = (color: string, dark: string) => {
    rect(ctx, P.ink, x + 3, y + 6, 10, 10);
    rect(ctx, color, x + 4, y + 7, 8, 8);
    rect(ctx, dark, x + 4, y + 12, 8, 3);
    rect(ctx, P.ink, x + 2, y + 5, 12, 3);
    rect(ctx, color, x + 3, y + 6, 10, 1);
  };
  switch (v % 4) {
    case 0: // big leafy plant
      pot(P.pot, P.potDark);
      for (const [lx, ly, lw, lh] of [[1, -4, 6, 5], [8, -7, 7, 6], [3, -12, 6, 6], [9, -1, 6, 5], [5, -2, 5, 5]]) {
        rect(ctx, P.ink, x + lx - 1 + sway * (ly < -5 ? 1 : 0), y + ly - 1, lw + 2, lh + 2);
      }
      for (const [lx, ly, lw, lh, c] of [[1, -4, 6, 5, P.leaf], [8, -7, 7, 6, P.leafDark], [3, -12, 6, 6, P.leaf], [9, -1, 6, 5, P.leaf], [5, -2, 5, 5, P.leafDark]] as const) {
        rect(ctx, c, x + lx + sway * (ly < -5 ? 1 : 0), y + ly, lw, lh);
        rect(ctx, P.leafLight, x + lx + 1 + sway * (ly < -5 ? 1 : 0), y + ly + 1, 2, 1);
      }
      break;
    case 1: // snake plant
      pot("#d9d4c8", "#b8b2a4");
      for (const [lx, top] of [[4, -10], [6, -15], [8, -12], [10, -8]]) {
        rect(ctx, P.ink, x + lx - 1, y + top - 1, 3, 8 - top);
        rect(ctx, "#4d7a45", x + lx, y + top, 1, 7 - top);
        rect(ctx, "#c9c46a", x + lx, y + top, 1, 1);
      }
      break;
    case 2: // round bush
      pot("#e8dcc2", "#cbb994");
      rect(ctx, P.ink, x + 1, y - 7, 14, 13);
      rect(ctx, P.ink, x + 3, y - 9, 10, 17);
      rect(ctx, P.leafDark, x + 2, y - 6, 12, 11);
      rect(ctx, P.leafDark, x + 4, y - 8, 8, 15);
      rect(ctx, P.leaf, x + 4, y - 7, 6, 6);
      rect(ctx, P.leafLight, x + 5 + sway, y - 6, 2, 2);
      rect(ctx, P.leafLight, x + 9, y - 2, 2, 1);
      break;
    default: // small tree
      pot("#5a4f4a", "#3d3533");
      rect(ctx, "#7a5134", x + 7, y - 4, 2, 10);
      rect(ctx, P.ink, x + 1 + sway, y - 17, 14, 15);
      rect(ctx, P.leafDark, x + 2 + sway, y - 16, 12, 13);
      rect(ctx, P.leaf, x + 3 + sway, y - 15, 7, 6);
      rect(ctx, P.leaf, x + 8 + sway, y - 9, 5, 4);
      rect(ctx, P.leafLight, x + 4 + sway, y - 14, 2, 2);
  }
}

// --- storage ---------------------------------------------------------------------------

function drawBookshelf(ctx: Ctx, x: number, y: number, w: number, v: number): void {
  const books = ["#c0583f", "#4f7cac", "#d9a441", "#5f9a57", "#8e6bb0", "#e8dcc2", "#3f4a52"];
  rect(ctx, P.shadow, x + 2, y + 13, w - 2, 4);
  rect(ctx, P.ink, x, y - 21, w, 37);
  rect(ctx, "#7a5134", x + 1, y - 20, w - 2, 35);
  rect(ctx, "#93643f", x + 1, y - 20, w - 2, 1);
  for (let shelf = 0; shelf < 3; shelf++) {
    const sy = y - 18 + shelf * 11;
    rect(ctx, "#4e321f", x + 3, sy, w - 6, 9);
    let bx = x + 4;
    let b = 0;
    while (bx < x + w - 5) {
      const bw = 2 + ((b + shelf + v) % 3 === 0 ? 1 : 0);
      const bh = 5 + ((b * 3 + shelf + v) % 4);
      if ((b + shelf * 2 + v) % 7 === 6) {
        // a leaning book, then a gap
        rect(ctx, books[(b + v) % books.length], bx + 1, sy + 9 - bh + 1, 2, bh - 1);
        bx += 5;
      } else {
        rect(ctx, books[(b * 5 + shelf * 2 + v) % books.length], bx, sy + 9 - bh, bw, bh);
        rect(ctx, "rgba(255,255,255,0.18)", bx, sy + 9 - bh + 1, 1, 1);
        bx += bw + 1;
      }
      b++;
    }
  }
  // something on top
  if (v % 2 === 0) {
    rect(ctx, P.ink, x + w - 10, y - 26, 6, 6);
    rect(ctx, P.mustard, x + w - 9, y - 25, 4, 4);
  } else {
    rect(ctx, P.leaf, x + 4, y - 25, 5, 4);
    rect(ctx, "#e8dcc2", x + 5, y - 22, 3, 2);
  }
}

function drawFilingCabinet(ctx: Ctx, x: number, y: number, w: number, v: number): void {
  rect(ctx, P.shadow, x + 2, y + 13, w - 2, 4);
  for (let i = 0; i < w / TILE; i++) {
    const cx = x + i * TILE;
    rect(ctx, P.ink, cx + 1, y - 13, 14, 29);
    rect(ctx, "#a7adb3", cx + 2, y - 12, 12, 27);
    rect(ctx, "#c3c8cc", cx + 2, y - 12, 12, 1);
    for (let d = 0; d < 3; d++) {
      const dy = y - 10 + d * 8;
      rect(ctx, "#8d9399", cx + 3, dy, 10, 7);
      rect(ctx, "#b9bec3", cx + 3, dy, 10, 1);
      rect(ctx, P.paper, cx + 6, dy + 2, 4, 2);
      rect(ctx, "#5a5b63", cx + 6, dy + 5, 4, 1);
    }
  }
  if (v % 2 === 0) {
    rect(ctx, P.paper, x + 4, y - 16, 8, 3);
    rect(ctx, P.paperShade, x + 5, y - 17, 8, 1);
  } else {
    rect(ctx, P.ink, x + w - 12, y - 19, 8, 6);
    rect(ctx, "#4f7cac", x + w - 11, y - 18, 6, 4);
    rect(ctx, P.ink, x + 4, y - 15, 9, 2);
  }
}

// --- meeting room and kitchen ----------------------------------------------------------

function drawMeetingTable(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  rect(ctx, P.shadow, x + 3, y + h - 3, w - 2, 4);
  rect(ctx, P.woodDeep, x + 3, y + h - 8, 3, 8);
  rect(ctx, P.woodDeep, x + w - 6, y + h - 8, 3, 8);
  rect(ctx, P.ink, x, y - 3, w, h - 2);
  rect(ctx, P.woodDark, x + 1, y + h - 13, w - 2, 7);
  rect(ctx, P.wood, x + 1, y - 2, w - 2, h - 15);
  rect(ctx, P.woodHi, x + 2, y - 2, w - 4, 1);
  rect(ctx, "#d6a575", x + 1, y + h - 14, w - 2, 1);
  // laptop, papers, water, the conference phone
  rect(ctx, P.ink, x + 8, y + 1, 14, 9);
  rect(ctx, "#9aa0a6", x + 9, y + 2, 12, 7);
  rect(ctx, "#cfd3d6", x + 9, y + 2, 12, 1);
  rect(ctx, P.paper, x + 28, y + 3, 8, 7);
  rect(ctx, P.paperShade, x + 30, y + 5, 5, 1);
  rect(ctx, P.ink, x + 38, y + 4, 9, 5);
  rect(ctx, "#5a5b63", x + 39, y + 5, 7, 3);
  rect(ctx, P.greenHi, x + 42, y + 6, 1, 1);
  for (const bx of [52, 60]) {
    rect(ctx, P.ink, x + bx, y, 4, 8);
    rect(ctx, "#bcd8de", x + bx + 1, y + 1, 2, 6);
  }
  rect(ctx, P.paper, x + 66, y + 4, 8, 7);
  rect(ctx, "#b8ad9a", x + 67, y + 6, 6, 1);
}

function drawCounter(ctx: Ctx, x: number, y: number, w: number, s: FurnitureState): void {
  rect(ctx, P.shadow, x + 2, y + 13, w, 4);
  // cabinets
  rect(ctx, P.ink, x - 1, y - 4, w + 2, 20);
  rect(ctx, "#e9dec4", x, y + 3, w, 12);
  for (let i = 0; i < w / TILE; i++) {
    rect(ctx, "#d2c4a3", x + i * TILE, y + 3, 1, 12);
    rect(ctx, "#a88d6a", x + i * TILE + 7, y + 7, 2, 1);
  }
  rect(ctx, "#c9b994", x, y + 14, w, 1);
  // worktop
  rect(ctx, "#cfc7b7", x, y - 3, w, 6);
  rect(ctx, "#e9e4d8", x, y - 3, w, 1);
  rect(ctx, "#b5ab97", x, y + 2, w, 1);
  // kettle (tile 0)
  rect(ctx, P.ink, x + 4, y - 11, 8, 9);
  rect(ctx, "#c3c8cc", x + 5, y - 10, 6, 7);
  rect(ctx, P.ink, x + 6, y - 12, 4, 1);
  rect(ctx, P.ink, x + 11, y - 9, 2, 1);
  // coffee machine (tile 1)
  const cx = x + TILE + 1;
  rect(ctx, P.ink, cx, y - 20, 14, 19);
  rect(ctx, "#5a4d49", cx + 1, y - 19, 12, 17);
  rect(ctx, "#6d5f5a", cx + 1, y - 19, 12, 1);
  rect(ctx, "#22303a", cx + 3, y - 17, 8, 3);
  rect(ctx, s.coffeeInUse ? "#9fe0b0" : "#4c6a5a", cx + 4, y - 16, Math.floor(s.t / 300) % 2 && s.coffeeInUse ? 6 : 3, 1);
  rect(ctx, "#2b2523", cx + 3, y - 11, 8, 8);
  rect(ctx, "#8a7a74", cx + 5, y - 11, 4, 2);
  rect(ctx, P.paper, cx + 5, y - 6, 4, 4);
  rect(ctx, "#7b4a2e", cx + 5, y - 6, 4, 1);
  rect(ctx, s.coffeeInUse ? (Math.floor(s.t / 400) % 2 ? "#e05a47" : "#7b2e24") : "#7b2e24", cx + 11, y - 13, 1, 1);
  if (s.coffeeInUse) {
    for (let i = 0; i < 3; i++) {
      const phase = ((s.t / 900 + i / 3) % 1);
      const sy = y - 8 - phase * 18;
      const sx = cx + 6 + Math.round(Math.sin(phase * 6 + i) * 2);
      rect(ctx, `rgba(255,255,255,${(0.75 * (1 - phase)).toFixed(2)})`, sx, sy, 1 + (i % 2), 3);
    }
  }
  // fruit bowl (tile 2)
  const fx = x + 2 * TILE + 2;
  rect(ctx, P.ink, fx, y - 6, 12, 4);
  rect(ctx, "#e8dcc2", fx + 1, y - 5, 10, 2);
  rect(ctx, P.red, fx + 2, y - 8, 3, 3);
  rect(ctx, P.mustard, fx + 5, y - 9, 3, 3);
  rect(ctx, P.leaf, fx + 8, y - 8, 3, 3);
  // sink (tile 3)
  const sx = x + 3 * TILE + 1;
  rect(ctx, "#8b9497", sx, y - 2, 14, 4);
  rect(ctx, "#b8c2c4", sx + 1, y - 1, 12, 2);
  rect(ctx, P.metal, sx + 6, y - 8, 2, 6);
  rect(ctx, P.metal, sx + 6, y - 8, 5, 2);
  // microwave (tile 4)
  const mx = x + 4 * TILE;
  rect(ctx, P.ink, mx + 1, y - 13, 15, 11);
  rect(ctx, "#d9d4c8", mx + 2, y - 12, 13, 9);
  rect(ctx, "#3d4a52", mx + 3, y - 11, 8, 7);
  rect(ctx, "#9fe0b0", mx + 12, y - 11, 2, 1);
  rect(ctx, "#8b8578", mx + 12, y - 8, 2, 3);
}

function drawFridge(ctx: Ctx, x: number, y: number): void {
  rect(ctx, P.shadow, x + 2, y + 13, 14, 4);
  rect(ctx, P.ink, x, y - 24, 16, 40);
  rect(ctx, "#ece8dd", x + 1, y - 23, 14, 38);
  rect(ctx, "#fbf9f3", x + 1, y - 23, 14, 1);
  rect(ctx, "#b8b2a4", x + 1, y - 8, 14, 1);
  rect(ctx, "#8b8578", x + 12, y - 19, 1, 6);
  rect(ctx, "#8b8578", x + 12, y - 4, 1, 8);
  rect(ctx, P.red, x + 3, y - 20, 2, 2);
  rect(ctx, P.blue, x + 6, y - 18, 2, 2);
  rect(ctx, P.mustard, x + 3, y - 4, 2, 2);
  rect(ctx, P.paper, x + 5, y - 3, 5, 6);
  rect(ctx, "#b8ad9a", x + 6, y - 1, 3, 1);
}

function drawKitchenTable(ctx: Ctx, x: number, y: number, w: number): void {
  softShadow(ctx, x + w / 2, y + 14, w - 4, 0.18);
  rect(ctx, P.woodDeep, x + w / 2 - 2, y + 4, 4, 10);
  rect(ctx, P.woodDeep, x + w / 2 - 6, y + 13, 12, 2);
  rect(ctx, P.ink, x + 2, y - 4, w - 4, 11);
  rect(ctx, P.ink, x + 1, y - 3, w - 2, 9);
  rect(ctx, P.woodHi, x + 2, y - 3, w - 4, 7);
  rect(ctx, "#d9a87a", x + 4, y - 3, w - 8, 1);
  rect(ctx, P.woodDark, x + 2, y + 4, w - 4, 2);
  // cups and a plate of biscuits
  rect(ctx, P.ink, x + 6, y - 3, 5, 5);
  rect(ctx, "#f4efe6", x + 7, y - 2, 3, 3);
  rect(ctx, P.ink, x + 15, y - 1, 9, 4);
  rect(ctx, P.paper, x + 16, y, 7, 2);
  rect(ctx, "#c99a64", x + 17, y - 1, 2, 2);
  rect(ctx, "#c99a64", x + 20, y - 1, 2, 2);
}

// --- open plan -------------------------------------------------------------------------

function drawMergeTable(ctx: Ctx, x: number, y: number, w: number, h: number, s: FurnitureState): void {
  rect(ctx, P.shadow, x + 3, y + h - 3, w - 2, 4);
  rect(ctx, "#4e321f", x + 3, y + h - 8, 3, 8);
  rect(ctx, "#4e321f", x + w - 6, y + h - 8, 3, 8);
  rect(ctx, P.ink, x, y - 3, w, h - 2);
  rect(ctx, "#5c3c26", x + 1, y + h - 13, w - 2, 7);
  rect(ctx, "#8c5f3c", x + 1, y - 2, w - 2, h - 15);
  rect(ctx, "#a87550", x + 2, y - 2, w - 4, 1);
  // a desk mat printed with a git branch merging back into main
  const mx = x + 8, my = y + 2;
  rect(ctx, "#2f3a42", mx, my, w - 16, 12);
  const glowing = s.mergeActive && Math.floor(s.t / 300) % 2 === 0;
  rect(ctx, "#9fc4e8", mx + 3, my + 8, w - 22, 1); // main line
  const dot = (dx: number, dy: number, c: string) => {
    rect(ctx, c, mx + dx - 1, my + dy - 1, 3, 3);
  };
  dot(5, 8, "#9fc4e8");
  dot(18, 8, "#9fc4e8");
  rect(ctx, P.mustard, mx + 10, my + 3, 1, 5); // the branch leaves...
  rect(ctx, P.mustard, mx + 10, my + 3, 16, 1);
  rect(ctx, P.mustard, mx + 26, my + 3, 1, 5); // ...and merges back
  dot(16, 3, P.mustard);
  dot(22, 3, P.mustard);
  dot(32, 8, glowing ? P.greenHi : P.green);
  if (s.mergeActive) rect(ctx, "rgba(154,208,138,0.25)", mx + 28, my + 4, 9, 9);
  // tent card: MERGE
  const card = "MERGE";
  const cw = textWidth(card) + 6;
  const cx = Math.round(x + w / 2 - cw / 2);
  rect(ctx, P.ink, cx, y - 10, cw, 10);
  rect(ctx, P.paper, cx + 1, y - 9, cw - 2, 8);
  rect(ctx, P.paperShade, cx + 1, y - 2, cw - 2, 1);
  drawText(ctx, card, cx + 3, y - 8, P.ink);
  rect(ctx, P.red, cx + 3, y - 3, cw - 6, 1);
  // two laptops, lit while integrating
  for (const lx of [x + 3, x + w - 15]) {
    rect(ctx, P.ink, lx, y + 15, 12, 7);
    rect(ctx, "#9aa0a6", lx + 1, y + 16, 10, 5);
    rect(ctx, s.mergeActive ? "#bfe6c7" : "#5a5b63", lx + 2, y + 16, 8, 1);
  }
}

function drawServerRack(ctx: Ctx, x: number, y: number, h: number, t: number): void {
  rect(ctx, P.shadow, x + 2, y + h - 3, 15, 4);
  rect(ctx, P.ink, x, y - 16, 16, h + 16);
  rect(ctx, "#2f3138", x + 1, y - 15, 14, h + 14);
  rect(ctx, "#444650", x + 1, y - 15, 14, 1);
  for (let u = 0; u < 8; u++) {
    const uy = y - 13 + u * 5;
    rect(ctx, "#3b3d46", x + 2, uy, 12, 4);
    rect(ctx, "#2a2c33", x + 3, uy + 1, 6, 1);
    for (let l = 0; l < 2; l++) {
      const on = noise(u, l, Math.floor(t / (180 + u * 37 + l * 53))) > 0.4;
      const color = l === 0 ? (on ? "#7dfc9a" : "#2f5e3c") : on ? "#ffcc5c" : "#6b5528";
      rect(ctx, color, x + 10 + l * 2, uy + 1, 1, 1);
    }
  }
  // cables out of the top
  rect(ctx, "#2b2523", x + 4, y - 19, 1, 4);
  rect(ctx, "#4f7cac", x + 7, y - 20, 1, 5);
  rect(ctx, "#c0583f", x + 10, y - 18, 1, 3);
}

function drawCooler(ctx: Ctx, x: number, y: number, t: number): void {
  softShadow(ctx, x + 8, y + 15, 12, 0.18);
  rect(ctx, P.ink, x + 3, y, 10, 16);
  rect(ctx, P.plastic, x + 4, y + 1, 8, 14);
  rect(ctx, P.plasticShade, x + 4, y + 8, 8, 1);
  rect(ctx, P.blue, x + 5, y + 4, 2, 2);
  rect(ctx, P.red, x + 9, y + 4, 2, 2);
  // the bottle
  rect(ctx, P.ink, x + 4, y - 14, 8, 15);
  rect(ctx, "#8fc1d6", x + 5, y - 13, 6, 13);
  rect(ctx, "#a9d3e4", x + 5, y - 13, 6, 3);
  rect(ctx, "#d4ecf4", x + 6, y - 12, 1, 9);
  const bubble = (t / 700) % 1;
  if (Math.floor(t / 700) % 3 === 0) rect(ctx, "#e8f6fb", x + 8, y - 2 - Math.floor(bubble * 10), 1, 1);
  // paper cups
  rect(ctx, P.ink, x + 12, y + 2, 4, 6);
  rect(ctx, P.paper, x + 13, y + 3, 2, 4);
}

function drawPrinter(ctx: Ctx, x: number, y: number, t: number): void {
  rect(ctx, P.shadow, x + 2, y + 13, 14, 4);
  rect(ctx, P.ink, x + 2, y + 2, 12, 14);
  rect(ctx, "#8a8f94", x + 3, y + 3, 10, 12);
  rect(ctx, "#a7adb3", x + 3, y + 3, 10, 1);
  rect(ctx, P.ink, x, y - 8, 16, 11);
  rect(ctx, "#e6e1d6", x + 1, y - 7, 14, 9);
  rect(ctx, "#3b3b42", x + 3, y - 6, 10, 2);
  rect(ctx, P.paper, x + 3, y - 11, 10, 4);
  rect(ctx, "#b8ad9a", x + 4, y - 9, 6, 1);
  rect(ctx, Math.floor(t / 1200) % 2 ? "#7dfc9a" : "#2f5e3c", x + 12, y - 1, 1, 1);
}

function drawSofa(ctx: Ctx, x: number, y: number, w: number): void {
  const fabric = "#c98f3a", dark = "#a8742c", hi = "#e0aa58";
  rect(ctx, P.shadow, x + 1, y + 12, w, 4);
  // back
  rect(ctx, P.ink, x - 1, y - 12, w + 2, 14);
  rect(ctx, fabric, x, y - 11, w, 12);
  rect(ctx, hi, x + 1, y - 11, w - 2, 1);
  for (let i = 1; i < w / TILE; i++) rect(ctx, dark, x + i * TILE, y - 9, 1, 9);
  // seat cushions
  rect(ctx, P.ink, x - 1, y, w + 2, 12);
  rect(ctx, dark, x, y + 8, w, 3);
  for (let i = 0; i < w / TILE; i++) {
    rect(ctx, fabric, x + i * TILE + 1, y + 1, TILE - 2, 7);
    rect(ctx, hi, x + i * TILE + 2, y + 1, TILE - 4, 1);
  }
  // armrests and feet
  for (const ax of [x - 3, x + w - 2]) {
    rect(ctx, P.ink, ax - 1, y - 6, 7, 18);
    rect(ctx, dark, ax, y - 5, 5, 16);
    rect(ctx, fabric, ax, y - 5, 5, 3);
  }
  rect(ctx, P.woodDeep, x + 1, y + 12, 2, 2);
  rect(ctx, P.woodDeep, x + w - 3, y + 12, 2, 2);
  // throw pillows
  rect(ctx, P.ink, x + 2, y - 7, 9, 8);
  rect(ctx, "#5f8580", x + 3, y - 6, 7, 6);
  rect(ctx, P.ink, x + w - 11, y - 7, 9, 8);
  rect(ctx, P.red, x + w - 10, y - 6, 7, 6);
}

function drawCoffeeTable(ctx: Ctx, x: number, y: number, w: number): void {
  rect(ctx, P.shadow, x + 2, y + 10, w - 2, 4);
  rect(ctx, P.woodDeep, x + 2, y + 6, 2, 7);
  rect(ctx, P.woodDeep, x + w - 4, y + 6, 2, 7);
  rect(ctx, P.ink, x, y - 1, w, 9);
  rect(ctx, P.woodHi, x + 1, y, w - 2, 5);
  rect(ctx, P.woodDark, x + 1, y + 5, w - 2, 2);
  // magazines and a mug
  rect(ctx, P.blue, x + 4, y + 1, 8, 3);
  rect(ctx, P.paper, x + 6, y, 8, 3);
  rect(ctx, P.red, x + 7, y + 1, 3, 1);
  rect(ctx, P.ink, x + 20, y, 5, 5);
  rect(ctx, P.mustard, x + 21, y + 1, 3, 3);
}

/** A one-seat armchair facing the room: back, cushion, two armrests, wooden feet. */
function drawArmchair(ctx: Ctx, x: number, y: number): void {
  const fabric = "#4f8a86", dark = "#3c6b68", hi = "#6aa8a3";
  rect(ctx, P.shadow, x, y + 12, 17, 4);
  rect(ctx, P.woodDeep, x + 2, y + 12, 2, 3);
  rect(ctx, P.woodDeep, x + 12, y + 12, 2, 3);
  // back
  rect(ctx, P.ink, x + 1, y - 10, 14, 13);
  rect(ctx, fabric, x + 2, y - 9, 12, 11);
  rect(ctx, hi, x + 3, y - 9, 10, 1);
  rect(ctx, dark, x + 7, y - 7, 2, 7);
  // seat cushion
  rect(ctx, P.ink, x + 1, y + 1, 14, 12);
  rect(ctx, fabric, x + 2, y + 2, 12, 7);
  rect(ctx, hi, x + 3, y + 2, 10, 1);
  rect(ctx, dark, x + 2, y + 9, 12, 3);
  // armrests
  for (const ax of [x - 2, x + 13]) {
    rect(ctx, P.ink, ax, y - 4, 5, 16);
    rect(ctx, dark, ax + 1, y - 3, 3, 14);
    rect(ctx, hi, ax + 1, y - 3, 3, 2);
  }
}

function drawFloorLamp(ctx: Ctx, x: number, y: number): void {
  glow(ctx, x + 8, y - 16, 22, "#ffd98a", 0.28);
  softShadow(ctx, x + 8, y + 14, 8, 0.2);
  rect(ctx, P.ink, x + 4, y + 12, 8, 3);
  rect(ctx, P.ink, x + 7, y - 14, 2, 27);
  rect(ctx, P.ink, x + 2, y - 23, 12, 10);
  rect(ctx, "#f6e7c1", x + 3, y - 22, 10, 8);
  rect(ctx, "#fff5d8", x + 4, y - 21, 3, 6);
}

function drawRug(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  rect(ctx, "#8f4c37", x + 2, y + 2, w - 4, h - 4);
  rect(ctx, "#b5654a", x + 4, y + 4, w - 8, h - 8);
  rect(ctx, "#e3b07a", x + 7, y + 7, w - 14, 1);
  rect(ctx, "#e3b07a", x + 7, y + h - 8, w - 14, 1);
  rect(ctx, "#e3b07a", x + 7, y + 7, 1, h - 14);
  rect(ctx, "#e3b07a", x + w - 8, y + 7, 1, h - 14);
  // a stepped inner border
  rect(ctx, "#a3573f", x + 10, y + 10, w - 20, 1);
  rect(ctx, "#a3573f", x + 10, y + h - 11, w - 20, 1);
  for (let i = 12; i < w - 12; i += 6) rect(ctx, "#d98c5f", x + i, y + 4, 2, 2);
  for (let i = 12; i < w - 12; i += 6) rect(ctx, "#d98c5f", x + i, y + h - 6, 2, 2);
  // fringe on the short sides
  for (let i = 4; i < h - 4; i += 2) {
    rect(ctx, "#e8dcc2", x, y + i, 2, 1);
    rect(ctx, "#e8dcc2", x + w - 2, y + i, 2, 1);
  }
}

/** A glass wall running east-west: a metal frame with panes you can see through. */
function drawGlassPartition(ctx: Ctx, x: number, y: number, w: number, t: number): void {
  const top = y - 18, bottom = y + 6;
  rect(ctx, P.shadow, x, bottom, w, 3);
  rect(ctx, "rgba(188,216,222,0.32)", x, top, w, bottom - top);
  // diagonal reflections that drift slowly
  for (let i = 0; i < w; i += 22) {
    const off = Math.floor((t / 160 + i) % 22);
    for (let k = 0; k < 8; k++) {
      const rx = x + i + off + k;
      if (rx < x + w - 2) rect(ctx, "rgba(255,255,255,0.35)", rx, top + 3 + k * 2, 1, 2);
    }
  }
  // frame: rails and posts
  rect(ctx, "#5a5b63", x, top, w, 2);
  rect(ctx, "#8a8c94", x, top, w, 1);
  rect(ctx, "#5a5b63", x, bottom - 2, w, 3);
  for (let px = x; px <= x + w; px += 32) rect(ctx, "#5a5b63", Math.min(px, x + w - 2), top, 2, bottom - top);
}

function drawBin(ctx: Ctx, x: number, y: number, v: number): void {
  softShadow(ctx, x + 8, y + 14, 8, 0.18);
  rect(ctx, P.ink, x + 4, y + 3, 8, 12);
  rect(ctx, v ? "#5f8580" : "#8a8f94", x + 5, y + 4, 6, 10);
  for (let i = 0; i < 3; i++) rect(ctx, "rgba(0,0,0,0.15)", x + 6 + i * 2, y + 5, 1, 8);
  rect(ctx, P.paper, x + 6, y + 1, 4, 3);
  rect(ctx, P.paperShade, x + 7, y + 2, 2, 1);
}
