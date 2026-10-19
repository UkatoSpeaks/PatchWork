import { describe, expect, it } from "vitest";

import { Actors } from "./animator";
import { spotFor, TILE } from "./layout";
import { initialScene, type Place, type SceneState } from "./reducer";

function withPlace(scene: SceneState, agent: "coder" | "reviewer", place: Place, trip?: number): SceneState {
  return {
    ...scene,
    agents: { ...scene.agents, [agent]: { ...scene.agents[agent], place, trip: trip ? { to: "coderDesk", key: trip } : null } },
  };
}

function run(actors: Actors, seconds: number) {
  for (let t = 0; t < seconds; t += 0.05) actors.update(0.05, 8);
}

describe("Actors", () => {
  it("walks tile by tile to the new place and sits down", () => {
    const scene = initialScene();
    const actors = new Actors(scene);
    const lounge = spotFor("coder", "lounge");
    expect(actors.actors.coder.tile).toEqual({ x: lounge.x, y: lounge.y });
    actors.sync(withPlace(scene, "coder", "desk"), false);
    actors.update(0.05, 8);
    expect(actors.isWalking("coder")).toBe(true);
    // Moves along one axis at a time, never diagonally.
    const { px, py } = actors.actors.coder;
    expect(px % TILE === 0 || py % TILE === 0).toBe(true);
    run(actors, 20);
    const desk = spotFor("coder", "desk");
    expect(actors.actors.coder.tile).toEqual({ x: desk.x, y: desk.y });
    expect(actors.isWalking("coder")).toBe(false);
    expect(actors.isSeated("coder")).toBe(true);
    expect(actors.actors.coder.facing).toBe("down");
  });

  it("snaps into place on a seek", () => {
    const scene = withPlace(initialScene(), "coder", "coffee");
    const actors = new Actors(initialScene());
    actors.sync(scene, true);
    const coffee = spotFor("coder", "coffee");
    expect(actors.actors.coder.px).toBe(coffee.x * TILE);
    expect(actors.isWalking("coder")).toBe(false);
  });

  it("runs a trip there and back", () => {
    let scene = withPlace(initialScene(), "reviewer", "desk");
    const actors = new Actors(scene);
    actors.sync(scene, true);
    scene = withPlace(scene, "reviewer", "desk", 1);
    actors.sync(scene, false);
    const visit = spotFor("reviewer", "coderDesk");
    let visited = false;
    for (let t = 0; t < 30; t += 0.05) {
      actors.update(0.05, 8);
      const tile = actors.actors.reviewer.tile;
      if (tile.x === visit.x && tile.y === visit.y) visited = true;
    }
    expect(visited).toBe(true);
    const desk = spotFor("reviewer", "desk");
    expect(actors.actors.reviewer.tile).toEqual({ x: desk.x, y: desk.y });
    expect(actors.isWalking("reviewer")).toBe(false);
  });
});
