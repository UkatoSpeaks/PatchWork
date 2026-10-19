// The office map: a 30x18 grid of 16px tiles (480x288 internal pixels).
//
//   lead's office | meeting room | kitchen          (rows 0-6)
//   ---- wall with doors and the test monitor ----  (rows 7-8)
//   open plan: tester + coder desks, merge table,   (rows 9-16)
//   reviewer's corner behind a divider
//
// Furniture marked `block` can't be walked through. `spots` are where agents
// stand or sit; the reducer only names places, this file turns them into tiles.

import type { CrewAgent } from "../types";
import type { Place } from "./reducer";

export const TILE = 16;
export const COLS = 30;
export const ROWS = 18;
export const WIDTH = COLS * TILE;
export const HEIGHT = ROWS * TILE;

export type TileKind = "cap" | "face" | "door" | "sage" | "wood" | "carpet" | "kitchen";
export type Facing = "down" | "up" | "left" | "right";

export interface Tile {
  x: number;
  y: number;
}

export interface Spot extends Tile {
  facing: Facing;
  seat?: boolean;
}

export type FurnitureKind =
  | "desk"
  | "plant"
  | "bookshelf"
  | "meetingTable"
  | "counter"
  | "fridge"
  | "kitchenTable"
  | "mergeTable"
  | "cooler"
  | "sofa"
  | "divider"
  | "chair"
  | "rug";

export interface Furniture {
  kind: FurnitureKind;
  x: number;
  y: number;
  w: number;
  h: number;
  block: boolean;
  // desk: whose desk it is (draws the monitor on the left tile)
  owner?: CrewAgent;
  facing?: Facing;
}

// Decorations mounted on wall faces (not obstacles).
export interface WallItem {
  kind: "window" | "whiteboard" | "calendar" | "testMonitor" | "clock" | "poster";
  x: number;
  y: number;
  w: number;
}

export const DOORS: Tile[] = [
  { x: 4, y: 7 }, { x: 4, y: 8 },
  { x: 14, y: 7 }, { x: 14, y: 8 },
  { x: 24, y: 7 }, { x: 24, y: 8 },
];

export function tileKind(x: number, y: number): TileKind {
  if (DOORS.some((d) => d.x === x && d.y === y)) return "door";
  if (y === 0 || y === 7 || y === ROWS - 1 || x === 0 || x === COLS - 1) return "cap";
  if (y < 7 && (x === 8 || x === 19)) return "cap";
  if (y === 1 || y === 8) return "face";
  if (y < 7) return x < 8 ? "wood" : x < 19 ? "carpet" : "kitchen";
  return "sage";
}

/** The floor a door tile is drawn with (the room it opens into). */
export function doorFloor(x: number): TileKind {
  return x < 8 ? "wood" : x < 19 ? "carpet" : "kitchen";
}

const f = (kind: FurnitureKind, x: number, y: number, w = 1, h = 1, block = true, extra: Partial<Furniture> = {}): Furniture => ({
  kind, x, y, w, h, block, ...extra,
});

export const FURNITURE: Furniture[] = [
  // Lead's office
  f("rug", 1, 5, 4, 2, false),
  f("desk", 2, 4, 3, 1, true, { owner: "lead" }),
  f("bookshelf", 6, 2, 2, 1),
  f("plant", 1, 2),
  f("plant", 7, 6),
  // Meeting room
  f("meetingTable", 11, 4, 5, 2),
  f("chair", 10, 4, 1, 1, false, { facing: "right" }),
  f("chair", 10, 5, 1, 1, false, { facing: "right" }),
  f("chair", 16, 4, 1, 1, false, { facing: "left" }),
  f("chair", 16, 5, 1, 1, false, { facing: "left" }),
  f("plant", 9, 2),
  f("plant", 18, 2),
  f("plant", 9, 6),
  // Kitchen
  f("counter", 20, 2, 5, 1),
  f("fridge", 27, 2, 1, 1),
  f("plant", 28, 2),
  f("kitchenTable", 25, 5, 2, 1),
  // Open plan
  f("desk", 3, 11, 3, 1, true, { owner: "tester" }),
  f("desk", 9, 11, 3, 1, true, { owner: "coder" }),
  f("mergeTable", 14, 13, 4, 2),
  f("cooler", 12, 9),
  f("bookshelf", 19, 9, 2, 1),
  f("divider", 22, 13, 1, 4),
  f("desk", 24, 15, 3, 1, true, { owner: "reviewer" }),
  f("sofa", 2, 15, 3, 1),
  f("plant", 1, 9),
  f("plant", 28, 9),
  f("plant", 1, 16),
  f("plant", 20, 16),
  f("plant", 28, 16),
];

export const WALL_ITEMS: WallItem[] = [
  { kind: "window", x: 2, y: 1, w: 2 },
  { kind: "calendar", x: 5, y: 1, w: 1 },
  { kind: "whiteboard", x: 11, y: 1, w: 5 },
  { kind: "clock", x: 17, y: 1, w: 1 },
  { kind: "window", x: 25, y: 1, w: 2 },
  { kind: "window", x: 6, y: 8, w: 2 },
  { kind: "testMonitor", x: 15, y: 8, w: 3 },
  { kind: "poster", x: 10, y: 8, w: 1 },
  { kind: "window", x: 20, y: 8, w: 2 },
  { kind: "window", x: 26, y: 8, w: 2 },
];

const SEATS: Record<CrewAgent, Spot> = {
  lead: { x: 3, y: 3, facing: "down", seat: true },
  tester: { x: 4, y: 10, facing: "down", seat: true },
  coder: { x: 10, y: 10, facing: "down", seat: true },
  reviewer: { x: 25, y: 14, facing: "down", seat: true },
};

const COFFEE: Record<CrewAgent, Spot> = {
  lead: { x: 20, y: 3, facing: "up" },
  tester: { x: 21, y: 3, facing: "up" },
  coder: { x: 22, y: 3, facing: "up" },
  reviewer: { x: 23, y: 3, facing: "up" },
};

// Where agents hang out before they start: around the kitchen table.
const LOUNGE: Record<CrewAgent, Spot> = {
  lead: { x: 24, y: 5, facing: "right" },
  tester: { x: 25, y: 4, facing: "down" },
  coder: { x: 26, y: 4, facing: "down" },
  reviewer: { x: 27, y: 5, facing: "left" },
};

const MERGE: Partial<Record<CrewAgent, Spot>> = {
  tester: { x: 13, y: 13, facing: "right" },
  coder: { x: 18, y: 13, facing: "left" },
  lead: { x: 15, y: 12, facing: "down" },
  reviewer: { x: 16, y: 15, facing: "up" },
};

export const WHITEBOARD_SPOT: Spot = { x: 13, y: 2, facing: "up" };
// Beside the coder's desk, where the reviewer goes to hand back feedback.
export const CODER_VISIT_SPOT: Spot = { x: 11, y: 10, facing: "left" };

export function spotFor(agent: CrewAgent, place: Place): Spot {
  switch (place) {
    case "desk":
      return SEATS[agent];
    case "coffee":
      return COFFEE[agent];
    case "whiteboard":
      return WHITEBOARD_SPOT;
    case "merge":
      return MERGE[agent] ?? SEATS[agent];
    case "coderDesk":
      return CODER_VISIT_SPOT;
    case "lounge":
    default:
      return LOUNGE[agent];
  }
}

const blocked: boolean[][] = Array.from({ length: ROWS }, (_, y) =>
  Array.from({ length: COLS }, (_, x) => {
    const kind = tileKind(x, y);
    return kind === "cap" || kind === "face";
  }),
);
for (const item of FURNITURE) {
  if (!item.block) continue;
  for (let y = item.y; y < item.y + item.h; y++) for (let x = item.x; x < item.x + item.w; x++) blocked[y][x] = true;
}

export function walkable(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < COLS && y < ROWS && !blocked[y][x];
}

/** Shortest 4-way path from `from` to `to`, excluding `from`. Empty if unreachable or already there. */
export function findPath(from: Tile, to: Tile): Tile[] {
  if (from.x === to.x && from.y === to.y) return [];
  const key = (t: Tile) => t.y * COLS + t.x;
  const previous = new Map<number, number>([[key(from), -1]]);
  const queue: Tile[] = [from];
  while (queue.length) {
    const current = queue.shift()!;
    if (current.x === to.x && current.y === to.y) {
      const path: Tile[] = [];
      for (let k = key(current); k !== key(from); k = previous.get(k)!) path.push({ x: k % COLS, y: Math.floor(k / COLS) });
      return path.reverse();
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: current.x + dx, y: current.y + dy };
      const isGoal = next.x === to.x && next.y === to.y;
      if (!previous.has(key(next)) && (walkable(next.x, next.y) || isGoal)) {
        previous.set(key(next), key(current));
        queue.push(next);
      }
    }
  }
  return [];
}
