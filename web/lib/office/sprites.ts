// Drawing primitives shared by the office art: the palette, filled rectangles
// (everything is drawn with them, no image assets), a 3x5 bitmap font for
// signs, soft pixel shadows and the confetti / rain-cloud effects. All
// coordinates are internal canvas pixels.

type Ctx = CanvasRenderingContext2D;

export const PALETTE = {
  ink: "#2b2523",
  cream: "#f4ead5",
  wallCap: "#3d3533",
  wallCapHi: "#514642",
  wallFace: "#e8dcc2",
  wallFaceShade: "#d8c9aa",
  wallFaceDark: "#cbb994",
  baseboard: "#8b6f55",
  sage: "#a9b795",
  sageGrout: "#97a585",
  carpetLead: "#a2645a",
  carpetLeadDot: "#955a51",
  carpetMeeting: "#7f97a3",
  carpetMeetingDot: "#748c98",
  kitchenA: "#ece0c6",
  kitchenB: "#d9b394",
  wood: "#b5804f",
  woodHi: "#c79262",
  woodDark: "#8a5a37",
  woodDeep: "#6e4529",
  shadow: "rgba(43,37,35,0.18)",
  shadowSoft: "rgba(43,37,35,0.10)",
  metal: "#5a5b63",
  metalDark: "#3b3b42",
  metalLight: "#8a8c94",
  plastic: "#d9d4c8",
  plasticShade: "#b8b2a4",
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
  paperShade: "#e6dfcf",
  red: "#c0583f",
  green: "#5f9a57",
  greenHi: "#9ad08a",
  redHi: "#f08a74",
  blue: "#4f7cac",
  mustard: "#d9a441",
  plum: "#8e6bb0",
  fabric: "#5e6f7a",
  fabricDark: "#46535c",
  steam: "rgba(255,255,255,0.7)",
};

// Each agent's colour, used for monitor glow, log prefixes and the selection outline.
export const AGENT_COLORS = {
  lead: "#c0583f",
  tester: "#5f9a57",
  coder: "#4f7cac",
  reviewer: "#8e6bb0",
  orchestrator: "#8b6f55",
} as const;

// --- primitives -----------------------------------------------------------------

let greyMode = false;

/** Draw everything in washed-out grey (cancelled agents) until turned off. */
export function setGrey(on: boolean): void {
  greyMode = on;
}

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

/** A 1px outlined box: ink border, `fill` inside. */
export function box(ctx: Ctx, fill: string, x: number, y: number, w: number, h: number, border: string = PALETTE.ink): void {
  rect(ctx, border, x, y, w, h);
  rect(ctx, fill, x + 1, y + 1, w - 2, h - 2);
}

/** A soft pixel ellipse shadow centred at (cx, cy). */
export function softShadow(ctx: Ctx, cx: number, cy: number, w: number, alpha = 0.2): void {
  const color = `rgba(43,37,35,${alpha})`;
  const inner = Math.max(2, w - 4);
  rect(ctx, color, cx - inner / 2, cy - 1, inner, 1);
  rect(ctx, color, cx - w / 2, cy, w, 1);
  rect(ctx, color, cx - inner / 2, cy + 1, inner, 1);
}

/** A soft round glow (monitors, lamps). */
export function glow(ctx: Ctx, cx: number, cy: number, radius: number, color: string, alpha: number): void {
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  gradient.addColorStop(0, withAlpha(color, alpha));
  gradient.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
}

export function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Deterministic per-position noise in [0, 1). */
export function noise(x: number, y: number, salt = 0): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + salt * 37.719) * 43758.5453;
  return s - Math.floor(s);
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
  ".": ["...", "...", "...", "...", ".#."], ":": ["...", ".#.", "...", ".#.", "..."], "!": [".#.", ".#.", ".#.", "...", ".#."],
  "?": ["##.", "..#", ".#.", "...", ".#."], "-": ["...", "...", "###", "...", "..."], "/": ["..#", "..#", ".#.", "#..", "#.."],
  "+": ["...", ".#.", "###", ".#.", "..."], "%": ["#.#", "..#", ".#.", "#..", "#.#"], " ": ["...", "...", "...", "...", "..."],
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

// --- effects ---------------------------------------------------------------------------------

const CONFETTI_COLORS = ["#c0583f", "#d9a441", "#5f9a57", "#4f7cac", "#8e6bb0", "#f08a74"];

/** Confetti over the area around (cx, top), falling for a while then fading. */
export function drawConfetti(ctx: Ctx, cx: number, top: number, width: number, height: number, seconds: number): void {
  const fade = seconds > 9 ? Math.max(0, 1 - (seconds - 9) / 3) : 1;
  if (fade <= 0) return;
  for (let i = 0; i < 110; i++) {
    const r = noise(i, 7);
    const speed = 24 + r * 34;
    const fallen = seconds * speed + r * height * 1.5 - 30;
    // pieces only fall in during the first pass, then keep looping until faded
    if (fallen < 0) continue;
    const y = top + (fallen % (height + 30)) - 10;
    const x = cx - width / 2 + ((i * 53.7 + r * 97) % width) + Math.sin(seconds * 3 + i) * 5;
    if (r > 1 - fade || fade === 1) {
      rect(ctx, CONFETTI_COLORS[i % CONFETTI_COLORS.length], x, y, Math.floor(seconds * 6 + i) % 2 ? 2 : 1, 2);
    }
  }
}

export function drawRainCloud(ctx: Ctx, cx: number, top: number, seconds: number): void {
  const x = Math.round(cx - 12 + Math.sin(seconds * 1.5) * 2);
  rect(ctx, "#4c545d", x + 1, top + 2, 24, 9);
  rect(ctx, "#5d6670", x + 2, top + 3, 22, 7);
  rect(ctx, "#77808a", x + 5, top, 9, 6);
  rect(ctx, "#77808a", x + 12, top + 1, 9, 6);
  rect(ctx, "#8e979f", x + 6, top + 1, 4, 2);
  for (let i = 0; i < 5; i++) {
    const dy = (seconds * 40 + i * 7) % 16;
    rect(ctx, "#7fa6c9", x + 4 + i * 4, top + 11 + dy, 1, 3);
  }
}
