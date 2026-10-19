// The four crew characters, drawn from rectangles: about 16x26 pixels, a 1px
// dark outline, a hairstyle, skin tone and clothes per role, and a role
// accessory (the lead's tie, the tester's clipboard, the coder's headphones,
// the reviewer's glasses). Every pose is built as a list of parts in a 16px
// wide local frame whose row 0 is the top of the head and row 25 the soles.

import type { CrewAgent } from "../types";
import type { Pose } from "./animator";
import type { Facing } from "./layout";
import { PALETTE, rect, setGrey, softShadow } from "./sprites";

type Ctx = CanvasRenderingContext2D;

export interface Look {
  skin: string;
  skinShade: string;
  hair: string;
  hairHi: string;
  shirt: string;
  shirtShade: string;
  inner?: string;
  pants: string;
  shoes: string;
  accent: string;
  hairStyle: "side" | "ponytail" | "curly" | "long";
  accessory: "tie" | "clipboard" | "headphones" | "glasses";
}

export const LOOKS: Record<CrewAgent, Look> = {
  lead: {
    skin: "#e8b48f", skinShade: "#c98f6b", hair: "#3b2a20", hairHi: "#5e4636", shirt: "#eef1f4", shirtShade: "#c3ccd5",
    pants: "#2f3a56", shoes: "#2b2523", accent: "#c0583f", hairStyle: "side", accessory: "tie",
  },
  tester: {
    skin: "#f6d3b5", skinShade: "#dba98a", hair: "#e2b04f", hairHi: "#f4d07e", shirt: "#5f9a57", shirtShade: "#477a42",
    pants: "#8a7458", shoes: "#5b3b28", accent: "#c0583f", hairStyle: "ponytail", accessory: "clipboard",
  },
  coder: {
    skin: "#8d5a3b", skinShade: "#6e4229", hair: "#1f2233", hairHi: "#3a4060", shirt: "#4f7cac", shirtShade: "#3a5f87",
    pants: "#2c2f3a", shoes: "#ece6da", accent: "#d9483b", hairStyle: "curly", accessory: "headphones",
  },
  reviewer: {
    skin: "#c98e66", skinShade: "#a8704c", hair: "#7a3b2e", hairHi: "#a05543", shirt: "#8e6bb0", shirtShade: "#6d4f8b",
    inner: "#f2e6d0", pants: "#4a4552", shoes: "#2b2523", accent: "#4a2a20", hairStyle: "long", accessory: "glasses",
  },
};

interface Part {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  outline: boolean;
  // 0: body, 1: things held over the body (outlined on top of it), 2: hands on the desk (drawn after the desk)
  layer: 0 | 1 | 2;
}

export interface DrawOptions {
  facing: Facing;
  pose: Pose;
  // animation time (ms) and pixels walked, for frames
  t: number;
  walked?: number;
  grey?: boolean;
  // an outline in this colour around the character (selection)
  highlight?: string | null;
  cup?: "mug" | "paper" | null;
  // body: everything but hands resting on a desk; front: only those hands
  layer?: "body" | "front" | "all";
}

const SEATED: Pose[] = ["sit", "type", "scroll", "sofa"];
const AGENT_PHASE: Record<CrewAgent, number> = { lead: 0, tester: 1, coder: 2, reviewer: 3 };

/** Rows above the standing tile's top edge where the character's head starts (for bubbles). */
export function characterTop(pose: Pose): number {
  if (SEATED.includes(pose)) return -7;
  if (pose === "celebrate") return -13;
  return -11;
}

interface Frame {
  walk: number; // 0-3
  breathe: number; // 0/1
  blink: boolean;
  tap: number; // typing 0/1
  alt: number; // generic 0/1 (talk, write, celebrate)
  cupUp: boolean;
}

function frameFor(agent: CrewAgent, o: DrawOptions): Frame {
  const phase = AGENT_PHASE[agent];
  const t = o.t;
  return {
    walk: Math.floor((o.walked ?? 0) / 4) % 4,
    breathe: Math.floor((t + phase * 397) / 900) % 2,
    blink: (t + phase * 1311) % 3900 < 140,
    tap: Math.floor((t + phase * 70) / 140) % 2,
    alt: Math.floor((t + phase * 120) / (o.pose === "celebrate" ? 260 : 320)) % 2,
    cupUp: ((t + phase * 500) % 2600) / 2600 > 0.45 && ((t + phase * 500) % 2600) / 2600 < 0.82,
  };
}

function build(look: Look, o: DrawOptions, fr: Frame): Part[] {
  const parts: Part[] = [];
  const add = (x: number, y: number, w: number, h: number, color: string, outline = true, layer: 0 | 1 | 2 = 0) =>
    parts.push({ x, y, w, h, color, outline, layer });
  const pose = o.pose;
  const facing = o.facing;
  const seated = SEATED.includes(pose) && facing === "down";
  const side = facing === "left" || facing === "right";
  const jump = pose === "celebrate" && fr.alt ? -2 : 0;
  const breathes = pose !== "walk" && pose !== "celebrate" && pose !== "type";
  const bob = (pose === "walk" && fr.walk % 2 === 1 ? -1 : 0) + (breathes ? fr.breathe : 0);
  const U = (seated ? 3 : 0) + bob + jump; // upper body offset
  const L = jump; // legs offset
  const holdsClipboard = look.accessory === "clipboard" && (pose === "stand" || pose === "walk" || pose === "look");
  const P = PALETTE;

  // --- legs -------------------------------------------------------------------------------
  if (seated) {
    add(4, 21, 8, 2, look.pants);
    add(4, 23, 3, 2, look.pants);
    add(9, 23, 3, 2, look.pants);
    add(3, 25, 4, 1, look.shoes);
    add(9, 25, 4, 1, look.shoes);
  } else if (side) {
    add(5, 18 + L, 6, 2, look.pants);
    const stride = pose === "walk" && fr.walk % 2 === 1;
    if (stride) {
      add(4, 20 + L, 3, 4, shade(look.pants));
      add(3, 24 + L, 4, 2, look.shoes);
      add(8, 20 + L, 3, 4, look.pants);
      add(8, 24 + L, 4, 2, look.shoes);
    } else {
      add(6, 20 + L, 4, 4, look.pants);
      add(6, 24 + L, 5, 2, look.shoes);
    }
  } else {
    add(4, 18 + L, 8, 2, look.pants);
    const liftL = pose === "walk" && fr.walk === 1 ? 1 : 0;
    const liftR = pose === "walk" && fr.walk === 3 ? 1 : 0;
    add(4, 20 + L, 3, 4 - liftL, look.pants);
    add(9, 20 + L, 3, 4 - liftR, look.pants);
    add(3, 24 + L - liftL, 4, 2, look.shoes);
    add(9, 24 + L - liftR, 4, 2, look.shoes);
  }

  // --- torso and arms ---------------------------------------------------------------------
  if (side) {
    add(5, 11 + U, 6, 7, look.shirt);
    add(5, 17 + U, 6, 1, look.shirtShade, false);
  } else {
    add(4, 11 + U, 8, 7, look.shirt);
    add(4, 17 + U, 8, 1, look.shirtShade, false);
  }

  const sleeve = look.shirtShade;
  if (side) {
    const swing = pose === "walk" ? (fr.walk === 1 ? 2 : fr.walk === 3 ? -2 : 0) : 0;
    if (pose === "drink") {
      add(9, 9 + U, 2, 4, sleeve, true, 1);
      add(11, 7 + U, 3, 3, o.cup === "paper" ? P.paper : "#f4efe6", true, 1);
    } else if (pose === "celebrate") {
      add(7, 3 + U, 2, 8, sleeve, true, 1);
      add(7, 1 + U, 2, 2, look.skin, true, 1);
    } else if (pose === "talk" && fr.alt) {
      add(8, 12 + U, 2, 3, sleeve, true, 1);
      add(10, 12 + U, 3, 2, look.skin, true, 1);
    } else {
      add(7 + swing, 12 + U, 2, 5, sleeve, true, 1);
      add(7 + swing, 17 + U, 2, 2, look.skin, true, 1);
    }
  } else if (pose === "celebrate") {
    add(1, 3 + U, 2, 8, sleeve);
    add(13, 3 + U, 2, 8, sleeve);
    add(1, 1 + U, 2, 2, look.skin);
    add(13, 1 + U, 2, 2, look.skin);
  } else if (pose === "write" && facing === "up") {
    add(1, 11 + U, 2, 6, sleeve);
    add(1, 17 + U, 2, 2, look.skin);
    add(13 - fr.alt, 2 + U, 2, 9, sleeve);
    add(13 - fr.alt, 0 + U, 2, 2, look.skin);
  } else if (seated) {
    add(1, 11 + U, 2, 5, sleeve);
    add(13, 11 + U, 2, 5, sleeve);
    if (pose === "type" || pose === "sit") {
      // forearms on the desk, drawn after it
      const tapL = pose === "type" ? fr.tap : 0;
      const tapR = pose === "type" ? 1 - fr.tap : 0;
      add(2, 16 + U, 3, 2, sleeve, true, 2);
      add(11, 16 + U, 3, 2, sleeve, true, 2);
      add(4, 18 + U - tapL, 3, 2, look.skin, true, 2);
      add(9, 18 + U - tapR, 3, 2, look.skin, true, 2);
    } else if (pose === "scroll") {
      add(3, 15 + U, 3, 2, sleeve, true, 1);
      add(10, 15 + U, 3, 2, sleeve, true, 1);
      add(5, 14 + U, 6, 4, P.metalDark, true, 1);
      add(6, 15 + U, 4, 2, "#9fd4e8", false, 1);
      add(5, 17 + U, 2, 1, look.skin, false, 1);
      add(9, 17 + U, 2, 1, look.skin, false, 1);
    } else {
      add(1, 16 + U, 2, 2, look.skin);
      add(13, 16 + U, 2, 2, look.skin);
    }
  } else {
    const swing = pose === "walk" ? (fr.walk === 1 ? 1 : fr.walk === 3 ? -1 : 0) : 0;
    add(1, 11 + U + swing, 2, 6, sleeve);
    add(1, 17 + U + swing, 2, 2, look.skin);
    if (pose === "drink" && fr.cupUp && facing === "down") {
      add(12, 9 + U, 2, 4, sleeve, true, 1);
      add(8, 6 + U, 4, 4, o.cup === "paper" ? P.paper : "#f4efe6", true, 1);
      if (o.cup !== "paper") add(12, 7 + U, 1, 2, "#f4efe6", true, 1);
    } else if (pose === "drink" && fr.cupUp && facing === "up") {
      add(13, 6 + U, 2, 6, sleeve, true, 1);
      add(13, 4 + U, 3, 3, o.cup === "paper" ? P.paper : "#f4efe6", true, 1);
    } else if (pose === "talk" && fr.alt) {
      add(13, 8 + U, 2, 5, sleeve);
      add(13, 6 + U, 2, 2, look.skin);
    } else {
      add(13, 11 + U - swing, 2, 6, sleeve);
      add(13, 17 + U - swing, 2, 2, look.skin);
      if (pose === "drink") {
        add(13, 18 + U, 3, 3, o.cup === "paper" ? P.paper : "#f4efe6", true, 1);
        if (o.cup !== "paper") add(16, 19 + U, 1, 1, "#f4efe6", false, 1);
      }
    }
    if (pose === "look" && facing === "up") {
      add(5, 16 + U, 6, 2, look.skin, true, 1); // hands clasped behind the back
    }
  }

  // clothing details on the chest (front only)
  if (facing === "down") {
    if (look.accessory === "tie") {
      add(6, 11 + U, 1, 1, look.shirtShade, false);
      add(9, 11 + U, 1, 1, look.shirtShade, false);
      add(7, 11 + U, 2, 1, "#8f3a28", false);
      add(7, 12 + U, 2, 4, look.accent, false);
      add(7, 16 + U, 2, 1, "#8f3a28", false);
    } else if (look.accessory === "headphones") {
      add(6, 12 + U, 1, 3, "#e8e1d4", false);
      add(9, 12 + U, 1, 3, "#e8e1d4", false);
      add(5, 15 + U, 6, 2, look.shirtShade, false);
    } else if (look.inner) {
      add(6, 11 + U, 4, 7, look.inner, false);
      add(5, 13 + U, 1, 1, look.inner, false);
    } else {
      add(5, 11 + U, 6, 1, look.shirtShade, false);
      add(7, 12 + U, 2, 2, "#e9e1cf", false);
    }
  } else if (facing === "up" && look.accessory === "headphones") {
    add(5, 11 + U, 6, 2, look.shirtShade, false); // the hood
  } else if (side && look.accessory === "tie") {
    add(10, 12 + U, 1, 4, look.accent, false);
  }

  // --- head --------------------------------------------------------------------------------
  if (side) {
    add(6, 10 + U, 3, 1, look.skin, false);
    add(4, 1 + U, 9, 9, look.skin);
    add(13, 6 + U, 1, 1, look.skin); // nose
  } else {
    add(6, 10 + U, 4, 1, look.skin, false);
    if (facing === "up") {
      add(2, 5 + U, 1, 2, look.skin);
      add(13, 5 + U, 1, 2, look.skin);
    }
    add(3, 1 + U, 10, 9, look.skin);
  }
  hair(add, look, facing, U);

  // --- face ----------------------------------------------------------------------------------
  const eye = PALETTE.ink;
  if (facing === "down") {
    const lookDown = pose === "scroll";
    if (fr.blink || lookDown) {
      add(5, 6 + U, 2, 1, lookDown ? eye : look.skinShade, false);
      add(9, 6 + U, 2, 1, lookDown ? eye : look.skinShade, false);
    } else {
      add(5, 5 + U, 1, 2, eye, false);
      add(10, 5 + U, 1, 2, eye, false);
    }
    add(4, 7 + U, 1, 1, "#e59a86", false);
    add(11, 7 + U, 1, 1, "#e59a86", false);
    const open = pose === "celebrate" || (pose === "talk" && fr.alt);
    if (!(pose === "drink" && fr.cupUp)) add(7, 8 + U, 2, 1, open ? "#7a2e24" : look.skinShade, false);
  } else if (side) {
    if (fr.blink) add(10, 6 + U, 2, 1, look.skinShade, false);
    else add(10, 5 + U, 1, 2, eye, false);
    add(11, 8 + U, 2, 1, (pose === "talk" && fr.alt) || pose === "celebrate" ? "#7a2e24" : look.skinShade, false);
  }

  // --- head accessories -----------------------------------------------------------------
  if (look.accessory === "headphones") {
    if (side) {
      add(5, 0 + U, 4, 1, "#3b3b42", false);
      add(5, 4 + U, 3, 4, look.accent);
    } else {
      add(3, 0 + U, 10, 1, "#3b3b42", false);
      add(1, 4 + U, 2, 4, look.accent);
      add(13, 4 + U, 2, 4, look.accent);
    }
  } else if (look.accessory === "glasses") {
    const frame = look.accent;
    if (facing === "down") {
      for (const lens of [4, 9]) {
        add(lens, 4 + U, 3, 3, frame, false);
        add(lens + 1, 5 + U, 1, 1, fr.blink ? look.skinShade : eye, false);
      }
      add(7, 5 + U, 2, 1, frame, false);
    } else if (side) {
      add(9, 4 + U, 3, 3, frame, false);
      add(10, 5 + U, 1, 1, fr.blink ? look.skinShade : eye, false);
      add(6, 5 + U, 3, 1, frame, false);
    }
  }

  // --- held things ---------------------------------------------------------------------------
  if (holdsClipboard) {
    if (facing === "down") {
      add(13, 13 + U, 3, 7, "#9c6c45", true, 1);
      add(14, 14 + U, 2, 5, P.paper, false, 1);
      add(14, 13 + U, 2, 1, P.metalLight, false, 1);
    } else if (side) {
      add(10, 13 + U, 3, 5, "#9c6c45", true, 1);
      add(11, 14 + U, 2, 3, P.paper, false, 1);
    } else {
      add(0, 13 + U, 3, 7, "#9c6c45", true, 1);
    }
  }
  return parts;
}

type Add = (x: number, y: number, w: number, h: number, color: string, outline?: boolean, layer?: 0 | 1 | 2) => void;

function hair(add: Add, look: Look, facing: Facing, U: number): void {
  const h = look.hair, hi = look.hairHi;
  const side = facing === "left" || facing === "right";
  if (facing === "up") {
    switch (look.hairStyle) {
      case "curly":
        add(2, 0 + U, 12, 8, h);
        add(4, -1 + U, 2, 1, h);
        add(9, -1 + U, 3, 1, h);
        add(5, 2 + U, 2, 1, hi, false);
        add(9, 4 + U, 2, 1, hi, false);
        break;
      case "ponytail":
        add(3, 0 + U, 10, 8, h);
        add(6, 7 + U, 4, 7, h);
        add(6, 7 + U, 4, 1, look.accent, false);
        add(7, 9 + U, 1, 4, hi, false);
        break;
      case "long":
        add(3, 0 + U, 10, 8, h);
        add(2, 4 + U, 12, 9, h);
        add(5, 6 + U, 1, 6, hi, false);
        add(10, 6 + U, 1, 6, hi, false);
        break;
      default:
        add(3, 0 + U, 10, 8, h);
        add(5, 2 + U, 3, 1, hi, false);
    }
    return;
  }
  if (side) {
    switch (look.hairStyle) {
      case "curly":
        add(3, -1 + U, 10, 4, h);
        add(3, 3 + U, 4, 4, h);
        add(4, -2 + U, 2, 1, h);
        add(8, -2 + U, 2, 1, h);
        add(6, 0 + U, 2, 1, hi, false);
        break;
      case "ponytail":
        add(4, 0 + U, 9, 3, h);
        add(4, 3 + U, 3, 4, h);
        add(1, 3 + U, 3, 8, h);
        add(3, 3 + U, 1, 2, look.accent, false);
        add(7, 1 + U, 3, 1, hi, false);
        break;
      case "long":
        add(4, 0 + U, 9, 3, h);
        add(2, 3 + U, 5, 11, h);
        add(3, 6 + U, 1, 6, hi, false);
        break;
      default:
        add(4, 0 + U, 9, 3, h);
        add(4, 3 + U, 3, 3, h);
        add(9, 3 + U, 3, 1, h);
        add(7, 1 + U, 3, 1, hi, false);
    }
    return;
  }
  switch (look.hairStyle) {
    case "curly":
      add(2, 0 + U, 12, 4, h);
      add(2, 4 + U, 1, 3, h);
      add(13, 4 + U, 1, 3, h);
      add(3, -1 + U, 2, 1, h);
      add(6, -1 + U, 3, 1, h);
      add(10, -1 + U, 2, 1, h);
      add(4, 4 + U, 2, 1, h, false);
      add(9, 4 + U, 2, 1, h, false);
      add(5, 1 + U, 2, 1, hi, false);
      add(10, 2 + U, 1, 1, hi, false);
      break;
    case "ponytail":
      add(3, 0 + U, 10, 4, h);
      add(3, 4 + U, 1, 4, h);
      add(12, 4 + U, 1, 4, h);
      add(13, 3 + U, 2, 6, h); // the tail, peeking out
      add(13, 3 + U, 2, 1, look.accent, false);
      add(5, 4 + U, 2, 1, h, false);
      add(5, 1 + U, 3, 1, hi, false);
      break;
    case "long":
      add(3, 0 + U, 10, 4, h);
      add(2, 2 + U, 2, 12, h);
      add(12, 2 + U, 2, 12, h);
      add(4, 4 + U, 2, 1, h, false);
      add(10, 4 + U, 2, 1, h, false);
      add(6, 1 + U, 3, 1, hi, false);
      break;
    default:
      // short, neat, parted on one side
      add(3, 0 + U, 10, 3, h);
      add(3, 3 + U, 6, 1, h, false);
      add(3, 3 + U, 1, 3, h);
      add(12, 3 + U, 1, 2, h);
      add(9, 0 + U, 1, 2, hi, false);
      add(4, 1 + U, 3, 1, hi, false);
  }
}

function shade(hex: string): string {
  const c = (i: number) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.8).toString(16).padStart(2, "0");
  return `#${c(1)}${c(3)}${c(5)}`;
}

/**
 * Draw a character standing on the tile whose top-left is (ox, oy); feet at
 * oy + 15, head about 11px above the tile. Seated poses sit 3px lower so a
 * desk drawn after them covers their legs; pass layer "front" after the desk
 * to put their hands on it.
 */
export function drawCharacter(ctx: Ctx, agent: CrewAgent, ox: number, oy: number, o: DrawOptions): void {
  const look = LOOKS[agent];
  const fr = frameFor(agent, o);
  let parts = build(look, o, fr);
  if (o.facing === "left") parts = parts.map((p) => ({ ...p, x: 16 - p.x - p.w }));
  const layer = o.layer ?? "all";
  const wanted = (p: Part) => (layer === "all" ? true : layer === "front" ? p.layer === 2 : p.layer !== 2);
  const top = oy - 10;
  const seated = SEATED.includes(o.pose);
  if (layer !== "front" && !seated) {
    const air = o.pose === "celebrate" && fr.alt ? 2 : 0;
    softShadow(ctx, ox + 8, oy + 15, 14 - air * 2, 0.24 - air * 0.04);
  }
  setGrey(Boolean(o.grey));
  if (o.highlight) {
    for (const p of parts) if (wanted(p) && p.outline) rect(ctx, o.highlight, ox + p.x - 2, top + p.y - 2, p.w + 4, p.h + 4);
  }
  for (const level of [0, 1, 2] as const) {
    const group = parts.filter((p) => p.layer === level && wanted(p));
    for (const p of group) if (p.outline) rect(ctx, PALETTE.ink, ox + p.x - 1, top + p.y - 1, p.w + 2, p.h + 2);
    for (const p of group) rect(ctx, p.color, ox + p.x, top + p.y, p.w, p.h);
  }
  setGrey(false);
}

/** Head-and-shoulders portrait for the agent cards (a 20x20 canvas). */
export function drawPortrait(ctx: Ctx, agent: CrewAgent, t: number, grey = false): void {
  ctx.clearRect(0, 0, 20, 20);
  setGrey(grey);
  rect(ctx, "#efe3c9", 0, 0, 20, 20);
  rect(ctx, "#e3d4b4", 0, 15, 20, 5);
  setGrey(false);
  drawCharacter(ctx, agent, 2, 11, { facing: "down", pose: "stand", t, grey });
}
