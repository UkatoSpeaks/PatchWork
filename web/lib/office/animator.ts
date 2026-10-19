// Moves the characters through the office. The reducer says where each agent
// should be (a place); the animator walks them there one tile at a time, and
// runs errands (trips) there and back. On a seek it snaps them into place.

import type { CrewAgent } from "../types";
import { findPath, spotFor, TILE, type Facing, type Spot, type Tile } from "./layout";
import { CREW, type SceneState } from "./reducer";

interface Leg {
  spot: Spot;
  // seconds to stay once there before taking the next leg
  dwell: number;
}

export interface Actor {
  agent: CrewAgent;
  // pixel position of the 16x16 cell's top-left corner
  px: number;
  py: number;
  tile: Tile;
  next: Tile | null;
  legs: Leg[];
  home: Spot;
  facing: Facing;
  walked: number;
  dwell: number;
  tripKey: number | null;
}

const same = (a: Tile, b: Tile) => a.x === b.x && a.y === b.y;

export class Actors {
  readonly actors: Record<CrewAgent, Actor>;

  constructor(scene: SceneState) {
    this.actors = Object.fromEntries(
      CREW.map((agent) => {
        const home = spotFor(agent, scene.agents[agent].place);
        const actor: Actor = {
          agent, px: home.x * TILE, py: home.y * TILE, tile: { x: home.x, y: home.y }, next: null, legs: [], home,
          facing: home.facing, walked: 0, dwell: 0, tripKey: scene.agents[agent].trip?.key ?? null,
        };
        return [agent, actor];
      }),
    ) as Record<CrewAgent, Actor>;
  }

  /** Point every actor at where the scene wants it. `snap` teleports (after a seek). */
  sync(scene: SceneState, snap: boolean): void {
    for (const agent of CREW) {
      const actor = this.actors[agent];
      const state = scene.agents[agent];
      const home = spotFor(agent, state.place);
      const trip = state.trip;
      if (snap) {
        Object.assign(actor, {
          px: home.x * TILE, py: home.y * TILE, tile: { x: home.x, y: home.y }, next: null, legs: [], home,
          facing: home.facing, dwell: 0, tripKey: trip?.key ?? null,
        });
        continue;
      }
      if (trip && trip.key !== actor.tripKey) {
        actor.tripKey = trip.key;
        actor.legs = [{ spot: spotFor(agent, trip.to), dwell: 1.4 }, { spot: home, dwell: 0 }];
        actor.dwell = 0;
      } else if (!same(home, actor.home) || home.facing !== actor.home.facing) {
        const last = actor.legs[actor.legs.length - 1];
        if (last && same(last.spot, actor.home)) last.spot = home;
        else {
          // Keep a short visit somewhere (e.g. coffee) visible before heading off again.
          actor.legs = [...actor.legs.slice(0, 1).filter((leg) => leg.dwell > 0), { spot: home, dwell: 0 }];
        }
      }
      actor.home = home;
    }
  }

  update(dt: number, tilesPerSecond: number): void {
    const step = tilesPerSecond * TILE * dt;
    for (const agent of CREW) {
      const actor = this.actors[agent];
      if (actor.dwell > 0) {
        actor.dwell = Math.max(0, actor.dwell - dt);
        continue;
      }
      let budget = step;
      while (budget > 0) {
        if (!actor.next) {
          const leg = actor.legs[0];
          if (!leg) break;
          if (same(actor.tile, leg.spot)) {
            actor.facing = leg.spot.facing;
            actor.dwell = leg.dwell;
            actor.legs.shift();
            if (actor.dwell > 0) break;
            continue;
          }
          const path = findPath(actor.tile, leg.spot);
          if (!path.length) {
            // Unreachable: don't get stuck, just appear there.
            actor.tile = { x: leg.spot.x, y: leg.spot.y };
            actor.px = leg.spot.x * TILE;
            actor.py = leg.spot.y * TILE;
            continue;
          }
          actor.next = path[0];
        }
        const tx = actor.next.x * TILE, ty = actor.next.y * TILE;
        const dx = tx - actor.px, dy = ty - actor.py;
        const distance = Math.abs(dx) + Math.abs(dy);
        if (dx > 0) actor.facing = "right";
        else if (dx < 0) actor.facing = "left";
        else if (dy > 0) actor.facing = "down";
        else if (dy < 0) actor.facing = "up";
        const move = Math.min(budget, distance);
        actor.px += Math.sign(dx) * Math.min(Math.abs(dx), move);
        actor.py += Math.sign(dy) * Math.min(Math.abs(dy), move);
        actor.walked += move;
        budget -= move;
        if (move >= distance) {
          actor.tile = actor.next;
          actor.next = null; // re-plan at every tile so new targets apply right away
        }
      }
    }
  }

  isWalking(agent: CrewAgent): boolean {
    const actor = this.actors[agent];
    return actor.next !== null || (actor.dwell === 0 && actor.legs.length > 0);
  }

  isSeated(agent: CrewAgent): boolean {
    const actor = this.actors[agent];
    return !this.isWalking(agent) && same(actor.tile, actor.home) && Boolean(actor.home.seat);
  }

  walkingAgents(): CrewAgent[] {
    return CREW.filter((agent) => this.isWalking(agent));
  }
}
