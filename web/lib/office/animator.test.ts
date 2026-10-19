import { describe, expect, it } from "vitest";

import type { CrewAgent } from "../types";
import { Actors } from "./animator";
import { bucketAssignments, idleEligible, IDLE_BUCKET_S } from "./idle";
import { findPath, spotFor, TILE } from "./layout";
import { initialScene, type Activity, type Place, type SceneState } from "./reducer";

function withAgent(scene: SceneState, agent: CrewAgent, place: Place, activity: Activity = "thinking", trip?: number): SceneState {
  return {
    ...scene,
    agents: {
      ...scene.agents,
      [agent]: { ...scene.agents[agent], place, activity, trip: trip ? { to: "coderDesk", key: trip, say: "Can you fix this?" } : null },
    },
  };
}

/** A scene where everyone is busy except `idle`, which is done at its desk. */
function busyExcept(idle: CrewAgent[], runId = "20261019-165358-6467"): SceneState {
  let scene: SceneState = { ...initialScene(), runId };
  for (const agent of ["lead", "tester", "coder", "reviewer"] as CrewAgent[]) {
    scene = withAgent(scene, agent, "desk", idle.includes(agent) ? "done" : "thinking");
  }
  return scene;
}

function run(actors: Actors, seconds: number, tps = 8) {
  for (let t = 0; t < seconds; t += 0.05) actors.update(0.05, tps);
}

const at = (actors: Actors, agent: CrewAgent, spot: { x: number; y: number }) =>
  actors.actors[agent].tile.x === spot.x && actors.actors[agent].tile.y === spot.y;

describe("Actors", () => {
  it("walks tile by tile to the new place and sits down", () => {
    const scene = withAgent(initialScene(), "coder", "lounge");
    const actors = new Actors(scene);
    const lounge = spotFor("coder", "lounge");
    expect(actors.actors.coder.tile).toEqual({ x: lounge.x, y: lounge.y });
    actors.sync(withAgent(scene, "coder", "desk"), false);
    actors.update(0.05, 8);
    expect(actors.isWalking("coder")).toBe(true);
    // Moves along one axis at a time, never diagonally.
    const { px, py } = actors.actors.coder;
    expect(px % TILE === 0 || py % TILE === 0).toBe(true);
    run(actors, 20);
    expect(at(actors, "coder", spotFor("coder", "desk"))).toBe(true);
    expect(actors.isWalking("coder")).toBe(false);
    expect(actors.isSeated("coder")).toBe(true);
    expect(actors.actors.coder.facing).toBe("down");
  });

  it("snaps into place on a seek", () => {
    const scene = withAgent(initialScene(), "coder", "coffee", "waiting");
    const actors = new Actors(initialScene());
    actors.sync(scene, true);
    const coffee = spotFor("coder", "coffee");
    expect(actors.actors.coder.px).toBe(coffee.x * TILE);
    expect(actors.isWalking("coder")).toBe(false);
    expect(actors.view("coder")).toMatchObject({ pose: "drink", cup: "mug" });
  });

  it("runs a trip there and back, saying its line at the far end", () => {
    let scene = withAgent(initialScene(), "reviewer", "desk");
    const actors = new Actors(scene);
    actors.sync(scene, true);
    scene = withAgent(scene, "reviewer", "desk", "thinking", 1);
    actors.sync(scene, false);
    const visit = spotFor("reviewer", "coderDesk");
    let said: string | null = null;
    for (let t = 0; t < 30; t += 0.05) {
      actors.update(0.05, 8);
      if (at(actors, "reviewer", visit)) said = said ?? actors.view("reviewer").say;
    }
    expect(said).toBe("Can you fix this?");
    expect(at(actors, "reviewer", spotFor("reviewer", "desk"))).toBe(true);
    expect(actors.isWalking("reviewer")).toBe(false);
  });
});

describe("idle office life", () => {
  it("only agents with nothing to do are idle", () => {
    const scene = busyExcept(["tester"]);
    expect(idleEligible(scene, "tester")).toBe(true);
    expect(idleEligible(scene, "coder")).toBe(false);
    expect(idleEligible(withAgent(scene, "tester", "merge", "done"), "tester")).toBe(false);
    expect(idleEligible({ ...scene, outcome: "success" }, "tester")).toBe(false);
  });

  it("gets up and does office things, the same way every time", () => {
    const trace = () => {
      const actors = new Actors(busyExcept(["tester", "reviewer"]));
      const tiles: string[] = [];
      for (let t = 0; t < 90; t += 0.05) {
        actors.update(0.05, 8);
        tiles.push(`${actors.actors.tester.tile.x},${actors.actors.tester.tile.y}|${actors.actors.reviewer.tile.x},${actors.actors.reviewer.tile.y}`);
      }
      return tiles;
    };
    const a = trace();
    expect(trace()).toEqual(a);
    const desk = spotFor("tester", "desk");
    expect(a.some((t) => t.split("|")[0] !== `${desk.x},${desk.y}`)).toBe(true);
  });

  it("picks errands per run id and time bucket, deterministically", () => {
    const eligible: CrewAgent[] = ["lead", "tester", "reviewer"];
    for (let bucket = 0; bucket < 20; bucket++) {
      expect(bucketAssignments("run-a", bucket, eligible)).toEqual(bucketAssignments("run-a", bucket, eligible));
    }
    const kinds = new Set(Array.from({ length: 40 }, (_, b) => bucketAssignments("run-a", b, eligible).tester?.kind));
    expect(kinds.size).toBeGreaterThan(2);
    // a chat pairs two agents with each other, and never two errands to the same place
    for (let bucket = 0; bucket < 40; bucket++) {
      const plan = bucketAssignments("run-b", bucket, eligible);
      const chatting = eligible.filter((a) => plan[a]?.kind === "chat");
      expect([0, 2]).toContain(chatting.length);
      if (chatting.length) expect(plan[chatting[0]]?.partner).toBe(chatting[1]);
      const errands = eligible.map((a) => plan[a]?.kind).filter((k) => k && k !== "rest" && k !== "chat");
      expect(new Set(errands).size).toBe(errands.length);
    }
  });

  it("never delays an event-driven move: an idle errand is dropped at once", () => {
    const scene = busyExcept(["coder"]);
    const actors = new Actors(scene);
    const home = spotFor("coder", "desk");
    // Let the coder wander off on an errand.
    let t = 0;
    while (t < 20 * IDLE_BUCKET_S && (actors.actors.coder.mode !== "idle" || at(actors, "coder", home) || actors.actors.coder.dwell === 0)) {
      actors.update(0.05, 8);
      t += 0.05;
    }
    expect(actors.actors.coder.mode).toBe("idle");
    expect(at(actors, "coder", home)).toBe(false);

    // The coder is needed again (a retry starts): it heads straight for its desk.
    actors.sync(withAgent(scene, "coder", "desk", "thinking"), false);
    expect(actors.actors.coder.mode).toBe("scene");
    expect(actors.actors.coder.dwell).toBe(0);
    expect(actors.actors.coder.legs.map((l) => [l.spot.x, l.spot.y])).toEqual([[home.x, home.y]]);
    const tiles = findPath(actors.actors.coder.tile, home).length + 1;
    const tps = 8;
    let took = 0;
    while (!at(actors, "coder", home) || actors.isWalking("coder")) {
      actors.update(0.05, tps);
      took += 0.05;
      if (took > 60) break;
    }
    // no detour, no lingering: about as long as walking the path takes
    expect(took).toBeLessThanOrEqual(tiles / tps + 0.2);
  });

  it("pairs up for a chat and both say their line", () => {
    const actors = new Actors(busyExcept(["tester", "reviewer"], "chatty"));
    const lines = new Set<string>();
    for (let t = 0; t < 300 && lines.size < 2; t += 0.05) {
      actors.update(0.05, 8);
      for (const agent of ["tester", "reviewer"] as CrewAgent[]) {
        const say = actors.view(agent).say;
        if (say && actors.view(agent).pose === "talk") lines.add(`${agent}:${say}`);
      }
    }
    expect([...lines].map((l) => l.split(":")[0]).sort()).toEqual(["reviewer", "tester"]);
  });
});
