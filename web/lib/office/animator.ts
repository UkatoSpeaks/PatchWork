// Moves the characters through the office. The reducer says where each agent
// should be (a place); the animator walks them there one tile at a time, runs
// errands (trips) there and back, and fills idle time with office life
// (idle.ts). Scene moves always win: an idle plan or an errand is dropped the
// moment the agent gets a task, and an active agent stays at its work spot
// until the task is over. On a seek it snaps everyone into place.

import type { CrewAgent } from "../types";
import { bucketAssignments, idleBucket, idleEligible, idleLegs, restSpot, type IdleKind, type IdlePose, type Leg } from "./idle";
import { findPath, spotFor, TILE, WHITEBOARD_SPOT, type Facing, type Spot, type Tile } from "./layout";
import { CREW, elapsedSeconds, initialScene, type SceneState } from "./reducer";

export type { Leg } from "./idle";

export interface Actor {
  agent: CrewAgent;
  // pixel position of the standing tile's top-left corner (feet at py + 15)
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
  // The stop it last arrived at and how long ago (for poses and idle speech).
  stop: Leg | null;
  stopTime: number;
  // Who decided the current legs: the scene, a trip, or idle office life.
  mode: "scene" | "trip" | "idle";
  idle: { bucket: number; kind: IdleKind } | null;
}

export type Pose = "stand" | "walk" | "sit" | "type" | "write" | "drink" | "sofa" | "scroll" | "look" | "talk" | "celebrate";

export interface ActorView {
  pose: Pose;
  facing: Facing;
  // standing on a coffee-machine or water-cooler stop: which cup to hold
  cup: "mug" | "paper" | null;
  // the line said at an idle or trip stop right now
  say: string | null;
}

// How many events after an errand starts a deep link (?at=N) still shows it.
export const TRIP_FRESH_EVENTS = 2;

const same = (a: Tile, b: Tile) => a.x === b.x && a.y === b.y;

export class Actors {
  readonly actors: Record<CrewAgent, Actor>;
  scene: SceneState;
  // Animation seconds; idle choices are bucketed on it. A seek resets it to
  // the scene's elapsed time so deep links start out the same way.
  clock: number;

  constructor(scene: SceneState) {
    this.scene = scene;
    this.clock = elapsedSeconds(scene);
    this.actors = Object.fromEntries(
      CREW.map((agent) => {
        const home = spotFor(agent, scene.agents[agent].place);
        const actor: Actor = {
          agent, px: home.x * TILE, py: home.y * TILE, tile: { x: home.x, y: home.y }, next: null, legs: [], home,
          facing: home.facing, walked: 0, dwell: 0, tripKey: scene.agents[agent].trip?.key ?? null,
          stop: { spot: home, dwell: 0 }, stopTime: 0, mode: "scene", idle: null,
        };
        return [agent, actor];
      }),
    ) as Record<CrewAgent, Actor>;
  }

  /** Point every actor at where the scene wants it. `snap` teleports (after a seek). */
  sync(scene: SceneState, snap: boolean): void {
    this.scene = scene;
    if (snap) this.clock = elapsedSeconds(scene);
    for (const agent of CREW) {
      const actor = this.actors[agent];
      const state = scene.agents[agent];
      const home = spotFor(agent, state.place);
      const trip = state.trip;
      // A seek landing on (or just after) the event that started an errand still plays it.
      const tripFresh = trip != null && trip.at != null && scene.events - trip.at <= TRIP_FRESH_EVENTS;
      if (snap) {
        Object.assign(actor, {
          px: home.x * TILE, py: home.y * TILE, tile: { x: home.x, y: home.y }, next: null, legs: [], home,
          facing: home.facing, dwell: 0, tripKey: tripFresh ? null : trip?.key ?? null, stop: { spot: home, dwell: 0 }, stopTime: 0,
          mode: "scene", idle: null,
        });
        continue;
      }
      if (state.active && actor.mode !== "scene") {
        // A task starts: drop any errand or office life and go straight to work.
        actor.tripKey = trip?.key ?? actor.tripKey;
        this.interrupt(actor, home);
      } else if (trip && trip.key !== actor.tripKey) {
        actor.tripKey = trip.key;
        const say = trip.say ? { text: trip.say, from: 0, to: 2.4 } : undefined;
        actor.legs = [{ spot: spotFor(agent, trip.to), dwell: 2.4, pose: "talk", say }, { spot: home, dwell: 0 }];
        actor.dwell = 0;
        actor.mode = "trip";
        actor.idle = null;
      } else if (actor.mode === "idle" && !idleEligible(scene, agent)) {
        this.interrupt(actor, home);
      } else if (!same(home, actor.home) || home.facing !== actor.home.facing) {
        const last = actor.legs[actor.legs.length - 1];
        if (actor.mode === "idle") this.interrupt(actor, home);
        else if (last && same(last.spot, actor.home)) last.spot = home;
        else {
          // Keep a short visit somewhere (e.g. coffee) visible before heading off again.
          actor.legs = [...actor.legs.slice(0, 1).filter((leg) => leg.dwell > 0 && actor.mode !== "trip"), { spot: home, dwell: 0 }];
        }
      }
      actor.home = home;
    }
  }

  /** Drop idle plans at once and head for where the scene needs the agent. */
  private interrupt(actor: Actor, home: Spot): void {
    actor.legs = [{ spot: home, dwell: 0 }];
    actor.dwell = 0;
    actor.mode = "scene";
    actor.idle = null;
  }

  /** Start or continue idle office life for agents with nothing to do. */
  private planIdle(): void {
    const scene = this.scene;
    const runId = scene.runId ?? "office";
    const bucket = idleBucket(this.clock);
    const eligible = CREW.filter((agent) => idleEligible(scene, agent) && this.actors[agent].mode !== "trip");
    let assignments: ReturnType<typeof bucketAssignments> | null = null;
    for (const agent of eligible) {
      const actor = this.actors[agent];
      const home = restSpot(scene, agent);
      if (actor.mode !== "idle" || !actor.idle) {
        // Just became free: settle in at home first ("Checking emails").
        actor.mode = "idle";
        actor.idle = { bucket, kind: "rest" };
        const legs = idleLegs(runId, agent, bucket, { kind: "rest" }, home, true);
        // Keep walking where it was going if that's home already.
        actor.legs = legs;
        continue;
      }
      const busy = actor.legs.length > 0 || actor.dwell > 0 || actor.next !== null;
      if (busy || actor.idle.bucket === bucket) continue;
      assignments ??= bucketAssignments(runId, bucket, eligible);
      let assignment = assignments[agent] ?? { kind: "rest" as const };
      if (assignment.kind === "chat") {
        const partner = assignment.partner ? this.actors[assignment.partner] : null;
        const free = partner && partner.mode === "idle" && partner.idle && partner.legs.length === 0 && partner.dwell === 0 && !partner.next;
        if (!partner || !free || (partner.idle!.bucket === bucket && partner.idle!.kind !== "chat")) assignment = { kind: "rest" };
        else if (partner.idle!.bucket !== bucket) {
          // Start the chat for both at once.
          const theirs = assignments[partner.agent]!;
          partner.idle = { bucket, kind: "chat" };
          partner.legs = idleLegs(runId, partner.agent, bucket, theirs, restSpot(scene, partner.agent), false);
        }
      }
      actor.idle = { bucket, kind: assignment.kind };
      actor.legs = idleLegs(runId, agent, bucket, assignment, home, false);
    }
  }

  update(dt: number, tilesPerSecond: number): void {
    this.clock += dt;
    this.planIdle();
    const step = tilesPerSecond * TILE * dt;
    for (const agent of CREW) {
      const actor = this.actors[agent];
      actor.stopTime += dt;
      if (actor.dwell > 0) {
        const partner = actor.stop?.waitFor ? this.actors[actor.stop.waitFor] : null;
        if (partner) {
          const stillChatting = partner.mode === "idle" && partner.idle?.kind === "chat";
          const arrived = partner.stop?.waitFor === agent && partner.next === null;
          if (!stillChatting) actor.dwell = 0; // the partner got called away
          else if (!arrived) {
            actor.stopTime = 0; // wait for them before starting the conversation
            continue;
          }
        }
        actor.dwell = Math.max(0, actor.dwell - dt);
        if (actor.dwell > 0) continue;
      }
      let budget = step;
      while (budget > 0) {
        if (!actor.next) {
          const leg = actor.legs[0];
          if (!leg) break;
          if (same(actor.tile, leg.spot)) {
            actor.facing = leg.spot.facing;
            actor.dwell = leg.dwell;
            actor.stop = leg;
            actor.stopTime = 0;
            actor.legs.shift();
            if (actor.legs.length === 0 && actor.mode === "trip") actor.mode = "scene";
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
          actor.stop = null;
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
    return this.view(agent).pose === "sit" || ["type", "sofa", "scroll"].includes(this.view(agent).pose);
  }

  walkingAgents(): CrewAgent[] {
    return CREW.filter((agent) => this.isWalking(agent));
  }

  /** How to draw an agent right now. */
  view(agent: CrewAgent): ActorView {
    const actor = this.actors[agent];
    const state = this.scene.agents[agent];
    const stop = actor.stop;
    const view: ActorView = { pose: "stand", facing: actor.facing, cup: null, say: null };
    if (this.isWalking(agent) || !stop) {
      view.pose = "walk";
      return view;
    }
    if (stop.say && actor.stopTime >= stop.say.from && actor.stopTime < stop.say.to) view.say = stop.say.text;
    const busy = state.activity === "typing" || state.activity === "testing";
    const atHome = same(actor.tile, actor.home);
    if (stop.pose && (actor.dwell > 0 || actor.mode === "idle")) {
      switch (stop.pose) {
        case "drink":
          return { ...view, pose: "drink", cup: "paper" };
        case "coffee":
          return { ...view, pose: "drink", cup: "mug" };
        case "type":
          return { ...view, pose: stop.spot.seat === "chair" ? "type" : "stand" };
        default:
          return { ...view, pose: stop.pose };
      }
    }
    if (!atHome) return view;
    if (state.place === "celebrate" && this.scene.outcome === "success") return { ...view, pose: "celebrate" };
    if (state.place === "coffee") return { ...view, pose: "drink", cup: "mug" };
    // Waiting for the provider: a mug at the desk, not a trip to the kitchen.
    if (actor.home.seat === "chair" && state.active && state.activity === "waiting") return { ...view, pose: "sit", cup: "mug" };
    if (actor.home.seat === "chair") return { ...view, pose: busy ? "type" : "sit" };
    if (same(actor.home, WHITEBOARD_SPOT)) return { ...view, pose: busy || state.activity === "thinking" ? "write" : "stand" };
    return view;
  }
}

/** A stand-in for tests and the first render. */
export const emptyActors = () => new Actors(initialScene());

export type { IdlePose };
