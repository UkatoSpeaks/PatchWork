// The office map: a 36x24 grid of 16px tiles (576x384 internal pixels).
//
//   lead's office | meeting room | kitchen             (rows 3-8, walls 0-2)
//   ----- wall with doors, signs and the test TV -----  (rows 9-11)
//   open plan: two rows of desks (tester, coder and     (rows 12-22)
//   empty ones), the merge table and server rack, a
//   lounge, and the reviewer's corner behind glass
//
// Furniture marked `block` can't be walked through. `spots` are where agents
// stand or sit; the reducer only names places, this file turns them into tiles.

import type { CrewAgent } from "../types";
import type { Place } from "./reducer";

export const TILE = 16;
export const COLS = 36;
export const ROWS = 24;
export const WIDTH = COLS * TILE;
export const HEIGHT = ROWS * TILE;

export type TileKind = "cap" | "face" | "door" | "sage" | "carpetLead" | "carpetMeeting" | "kitchen";
export type Facing = "down" | "up" | "left" | "right";

export interface Tile {
  x: number;
  y: number;
}

export interface Spot extends Tile {
  facing: Facing;
  // Somewhere to sit: an office chair (at a desk) or the lounge sofa.
  seat?: "chair" | "sofa";
}

export type FurnitureKind =
  | "desk"
  | "chair"
  | "visitorChair"
  | "plant"
  | "bookshelf"
  | "filingCabinet"
  | "meetingTable"
  | "counter"
  | "fridge"
  | "kitchenTable"
  | "mergeTable"
  | "serverRack"
  | "cooler"
  | "printer"
  | "sofa"
  | "coffeeTable"
  | "armchair"
  | "floorLamp"
  | "rug"
  | "glassPartition"
  | "bin";

export interface Furniture {
  kind: FurnitureKind;
  x: number;
  y: number;
  w: number;
  h: number;
  block: boolean;
  // desk: whose desk it is (empty desks have none)
  owner?: CrewAgent;
  facing?: Facing;
  // a stable number that varies decoration (mug colour, lamp, plant...)
  variant?: number;
}

// Decorations mounted on wall faces (not obstacles). y is the wall's top face row.
export interface WallItem {
  kind: "window" | "whiteboard" | "calendar" | "testMonitor" | "clock" | "poster" | "sign" | "noticeBoard";
  x: number;
  y: number;
  w: number;
  text?: string;
  variant?: number;
}

export const TOP_FACE = 1; // rows 1-2: the back walls of the top rooms
export const MID_CAP = 9; // the wall between the rooms and the open plan
export const MID_FACE = 10; // rows 10-11: its face, seen from the open plan
export const ROOM_WALLS = [10, 24]; // x of the walls between the top rooms
export const DOOR_COLUMNS = [5, 17, 27]; // lead's office, meeting room, kitchen

export const DOORS: Tile[] = DOOR_COLUMNS.flatMap((x) => [9, 10, 11].map((y) => ({ x, y })));

export function tileKind(x: number, y: number): TileKind {
  if (y >= MID_CAP && y <= MID_FACE + 1 && DOOR_COLUMNS.includes(x)) return "door";
  if (x === 0 || x === COLS - 1 || y === 0 || y === ROWS - 1 || y === MID_CAP) return "cap";
  if (y < MID_CAP && ROOM_WALLS.includes(x)) return "cap";
  if (y === TOP_FACE || y === TOP_FACE + 1 || y === MID_FACE || y === MID_FACE + 1) return "face";
  if (y < MID_CAP) return roomFloor(x);
  return "sage";
}

/** The floor of the top room at column x. */
export function roomFloor(x: number): TileKind {
  return x < ROOM_WALLS[0] ? "carpetLead" : x < ROOM_WALLS[1] ? "carpetMeeting" : "kitchen";
}

const f = (kind: FurnitureKind, x: number, y: number, w = 1, h = 1, block = true, extra: Partial<Furniture> = {}): Furniture => ({
  kind, x, y, w, h, block, ...extra,
});

/** A 3-tile desk with its office chair behind it (the chair's tile is the seat). */
function desk(x: number, y: number, variant: number, owner?: CrewAgent): Furniture[] {
  return [f("desk", x, y, 3, 1, true, { owner, variant }), f("chair", x + 1, y - 1, 1, 1, false, { facing: "down", owner, variant })];
}

export const FURNITURE: Furniture[] = [
  // Lead's office
  ...desk(3, 5, 1, "lead"),
  f("visitorChair", 3, 6, 1, 1, false, { facing: "up" }),
  f("visitorChair", 5, 6, 1, 1, false, { facing: "up", variant: 1 }),
  f("bookshelf", 6, 3, 2, 1),
  f("filingCabinet", 8, 3, 1, 1),
  f("plant", 9, 3, 1, 1, true, { variant: 2 }),
  f("plant", 1, 8, 1, 1, true, { variant: 0 }),
  f("floorLamp", 9, 8),
  // Meeting room
  f("meetingTable", 14, 5, 5, 2),
  ...[14, 16, 18].map((x) => f("visitorChair", x, 4, 1, 1, false, { facing: "down", variant: x })),
  ...[14, 16, 18].map((x) => f("visitorChair", x, 7, 1, 1, false, { facing: "up", variant: x })),
  f("visitorChair", 13, 5, 1, 1, false, { facing: "right" }),
  f("visitorChair", 19, 6, 1, 1, false, { facing: "left" }),
  f("plant", 11, 3, 1, 1, true, { variant: 1 }),
  f("plant", 23, 3, 1, 1, true, { variant: 3 }),
  f("plant", 11, 8, 1, 1, true, { variant: 2 }),
  f("plant", 23, 8, 1, 1, true, { variant: 0 }),
  // Kitchen
  f("counter", 25, 3, 5, 1),
  f("fridge", 30, 3, 1, 1),
  f("plant", 34, 3, 1, 1, true, { variant: 3 }),
  f("kitchenTable", 29, 6, 2, 1),
  f("bin", 34, 8),
  f("plant", 25, 8, 1, 1, true, { variant: 1 }),
  // Open plan: row A (tester, an empty desk, coder, an empty desk)
  ...desk(2, 14, 2, "tester"),
  ...desk(6, 14, 3),
  ...desk(10, 14, 4, "coder"),
  ...desk(14, 14, 5),
  // Row B: empty desks
  ...desk(2, 18, 6),
  ...desk(6, 18, 7),
  ...desk(10, 18, 8),
  f("bin", 5, 14),
  f("bin", 13, 18, 1, 1, true, { variant: 1 }),
  f("cooler", 9, 12),
  f("plant", 1, 12, 1, 1, true, { variant: 0 }),
  f("plant", 1, 22, 1, 1, true, { variant: 2 }),
  // Merge corner
  f("mergeTable", 20, 14, 4, 2),
  f("serverRack", 25, 13, 1, 2),
  // Lounge
  f("rug", 14, 18, 6, 4, false),
  f("sofa", 15, 18, 4, 1, true, { facing: "down" }),
  f("coffeeTable", 16, 20, 2, 1),
  f("armchair", 19, 20, 1, 1, true, { facing: "down" }),
  f("floorLamp", 14, 18),
  f("plant", 19, 18, 1, 1, true, { variant: 1 }),
  // Along the wall
  f("printer", 30, 12),
  f("filingCabinet", 32, 12, 2, 1, true, { variant: 1 }),
  f("plant", 34, 12, 1, 1, true, { variant: 3 }),
  // Reviewer's corner behind the glass
  f("glassPartition", 29, 14, 6, 1),
  ...desk(30, 18, 9, "reviewer"),
  f("bookshelf", 33, 19, 2, 1, true, { variant: 1 }),
  f("plant", 29, 15, 1, 1, true, { variant: 3 }),
  f("plant", 34, 22, 1, 1, true, { variant: 2 }),
  f("plant", 27, 22, 1, 1, true, { variant: 0 }),
];

export const WALL_ITEMS: WallItem[] = [
  // Back walls of the top rooms
  { kind: "window", x: 2, y: TOP_FACE, w: 2 },
  { kind: "calendar", x: 5, y: TOP_FACE, w: 1 },
  { kind: "whiteboard", x: 13, y: TOP_FACE, w: 6 },
  { kind: "window", x: 21, y: TOP_FACE, w: 2 },
  { kind: "window", x: 32, y: TOP_FACE, w: 2 },
  { kind: "poster", x: 11, y: TOP_FACE, w: 1, variant: 2 },
  // The open plan's wall
  { kind: "poster", x: 2, y: MID_FACE, w: 1, variant: 0 },
  { kind: "sign", x: 6, y: MID_FACE, w: 2, text: "LEAD" },
  { kind: "poster", x: 11, y: MID_FACE, w: 1, variant: 1 },
  { kind: "noticeBoard", x: 13, y: MID_FACE, w: 3 },
  { kind: "sign", x: 18, y: MID_FACE, w: 2, text: "MEETING" },
  { kind: "testMonitor", x: 20, y: MID_FACE, w: 3 },
  { kind: "clock", x: 24, y: MID_FACE, w: 1 },
  { kind: "poster", x: 25, y: MID_FACE, w: 1, variant: 3 },
  { kind: "sign", x: 28, y: MID_FACE, w: 2, text: "KITCHEN" },
];

const SEATS: Record<CrewAgent, Spot> = {
  lead: { x: 4, y: 4, facing: "down", seat: "chair" },
  tester: { x: 3, y: 13, facing: "down", seat: "chair" },
  coder: { x: 11, y: 13, facing: "down", seat: "chair" },
  reviewer: { x: 31, y: 17, facing: "down", seat: "chair" },
};

// In front of the kitchen counter; the coffee machine is on tile 26.
export const COFFEE_MACHINE: Tile = { x: 26, y: 3 };
const COFFEE: Record<CrewAgent, Spot> = {
  lead: { x: 25, y: 4, facing: "up" },
  tester: { x: 26, y: 4, facing: "up" },
  coder: { x: 27, y: 4, facing: "up" },
  reviewer: { x: 28, y: 4, facing: "up" },
};

// Where agents hang out before they start: around the kitchen table.
const LOUNGE: Record<CrewAgent, Spot> = {
  lead: { x: 28, y: 6, facing: "right" },
  tester: { x: 29, y: 5, facing: "down" },
  coder: { x: 30, y: 5, facing: "down" },
  reviewer: { x: 31, y: 6, facing: "left" },
};

const MERGE: Record<CrewAgent, Spot> = {
  tester: { x: 19, y: 14, facing: "right" },
  coder: { x: 24, y: 14, facing: "left" },
  lead: { x: 21, y: 13, facing: "down" },
  reviewer: { x: 22, y: 16, facing: "up" },
};

// In front of the merge table, facing the room, for the team photo.
const CELEBRATE: Record<CrewAgent, Spot> = {
  lead: { x: 20, y: 16, facing: "down" },
  tester: { x: 21, y: 16, facing: "down" },
  coder: { x: 22, y: 16, facing: "down" },
  reviewer: { x: 23, y: 16, facing: "down" },
};

export const WHITEBOARD_SPOT: Spot = { x: 16, y: 3, facing: "up" };
// Beside the coder's desk, where the reviewer goes to hand back feedback.
export const CODER_VISIT_SPOT: Spot = { x: 13, y: 13, facing: "left" };

// Destinations for idle office life (see idle.ts). One spot per agent, so two
// idle agents never stand on the same tile.
export const IDLE_SPOTS: Record<"cooler" | "sofa" | "window", Record<CrewAgent, Spot>> = {
  cooler: {
    lead: { x: 8, y: 12, facing: "right" },
    tester: { x: 10, y: 12, facing: "left" },
    coder: { x: 9, y: 13, facing: "up" },
    reviewer: { x: 10, y: 13, facing: "left" },
  },
  sofa: {
    lead: { x: 15, y: 18, facing: "down", seat: "sofa" },
    tester: { x: 16, y: 18, facing: "down", seat: "sofa" },
    coder: { x: 17, y: 18, facing: "down", seat: "sofa" },
    reviewer: { x: 18, y: 18, facing: "down", seat: "sofa" },
  },
  window: {
    lead: { x: 2, y: 3, facing: "up" },
    tester: { x: 32, y: 3, facing: "up" },
    coder: { x: 21, y: 3, facing: "up" },
    reviewer: { x: 33, y: 3, facing: "up" },
  },
};

// Two agents chatting stand here, facing each other.
export const CHAT_SPOTS: [Spot, Spot] = [
  { x: 18, y: 12, facing: "right" },
  { x: 19, y: 12, facing: "left" },
];

export function spotFor(agent: CrewAgent, place: Place): Spot {
  switch (place) {
    case "desk":
      return SEATS[agent];
    case "coffee":
      return COFFEE[agent];
    case "whiteboard":
      return WHITEBOARD_SPOT;
    case "merge":
      return MERGE[agent];
    case "celebrate":
      return CELEBRATE[agent];
    case "coderDesk":
      return CODER_VISIT_SPOT;
    case "lounge":
    default:
      return LOUNGE[agent];
  }
}

/** Every spot an agent can be sent to (for the reachability test). */
export function allSpots(agent: CrewAgent): Spot[] {
  const places: Place[] = ["lounge", "desk", "whiteboard", "coffee", "merge", "coderDesk", "celebrate"];
  return [...places.map((p) => spotFor(agent, p)), IDLE_SPOTS.cooler[agent], IDLE_SPOTS.sofa[agent], IDLE_SPOTS.window[agent], ...CHAT_SPOTS];
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

/**
 * Shortest 4-way path from `from` to `to`, excluding `from`. Empty if
 * unreachable or already there. The goal may be a blocked tile (a sofa seat).
 */
export function findPath(from: Tile, to: Tile): Tile[] {
  if (from.x === to.x && from.y === to.y) return [];
  const key = (t: Tile) => t.y * COLS + t.x;
  const previous = new Map<number, number>([[key(from), -1]]);
  const queue: Tile[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (current.x === to.x && current.y === to.y) {
      const path: Tile[] = [];
      for (let k = key(current); k !== key(from); k = previous.get(k)!) path.push({ x: k % COLS, y: Math.floor(k / COLS) });
      return path.reverse();
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: current.x + dx, y: current.y + dy };
      if (next.x < 0 || next.y < 0 || next.x >= COLS || next.y >= ROWS) continue;
      const isGoal = next.x === to.x && next.y === to.y;
      if (!previous.has(key(next)) && (walkable(next.x, next.y) || isGoal)) {
        previous.set(key(next), key(current));
        queue.push(next);
      }
    }
  }
  return [];
}
