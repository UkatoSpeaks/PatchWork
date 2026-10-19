// Office life for agents with nothing to do right now: the reviewer during
// implementation, the lead after planning, the tester once it's done. They
// fetch water, sit on the sofa, look out of a window, scroll at their desk or
// chat with each other. Choices are deterministic: seeded by the run id and a
// time bucket, so a deep link always starts the same way. Idle plans never
// outrank the scene: the animator drops them as soon as an agent is needed.

import type { CrewAgent } from "../types";
import { CHAT_SPOTS, IDLE_SPOTS, spotFor, type Spot } from "./layout";
import { CHATS, IDLE_PHRASES, pick, rng, seedOf } from "./phrases";
import { CREW, type SceneState } from "./reducer";

// How often idle agents pick something new to do (animation seconds).
export const IDLE_BUCKET_S = 10;

export type IdleKind = "rest" | "cooler" | "sofa" | "window" | "desk" | "chat";
export type IdlePose = "drink" | "sofa" | "scroll" | "look" | "talk" | "type";

export interface Say {
  text: string;
  // seconds after arriving at the stop
  from: number;
  to: number;
}

export interface Leg {
  spot: Spot;
  // seconds to stay once there before taking the next leg
  dwell: number;
  pose?: IdlePose;
  say?: Say;
  // a chat: the dwell only starts once this agent has arrived too
  waitFor?: CrewAgent;
}

export interface Assignment {
  kind: IdleKind;
  partner?: CrewAgent;
  line?: [string, string];
  // who opens the chat
  opener?: boolean;
}

/** An agent with nothing to do in the current phase, resting where the scene put it. */
export function idleEligible(scene: SceneState, agent: CrewAgent): boolean {
  const a = scene.agents[agent];
  if (!a.inRun || scene.outcome) return false;
  if (a.activity !== "idle" && a.activity !== "done") return false;
  return a.place === "desk" || a.place === "lounge";
}

export const idleBucket = (clock: number) => Math.floor(Math.max(0, clock) / IDLE_BUCKET_S);

/**
 * What each eligible agent should do in a bucket. At most one chat per bucket,
 * and no two agents get the same errand, so nobody shares a tile.
 */
export function bucketAssignments(runId: string, bucket: number, eligible: CrewAgent[]): Partial<Record<CrewAgent, Assignment>> {
  const random = rng(seedOf(runId, "idle", bucket));
  const order = CREW.filter((a) => eligible.includes(a));
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const out: Partial<Record<CrewAgent, Assignment>> = {};
  let rest = order;
  if (order.length >= 2 && random() < 0.4) {
    const line = CHATS[Math.floor(random() * CHATS.length)];
    out[order[0]] = { kind: "chat", partner: order[1], line: [...line], opener: true };
    out[order[1]] = { kind: "chat", partner: order[0], line: [...line], opener: false };
    rest = order.slice(2);
  }
  const taken = new Set<IdleKind>();
  for (const agent of rest) {
    const options: IdleKind[] = (["rest", "rest", "cooler", "sofa", "window", "desk"] as IdleKind[]).filter((k) => k === "rest" || !taken.has(k));
    const kind = options[Math.floor(random() * options.length)];
    taken.add(kind);
    out[agent] = { kind };
  }
  return out;
}

/** The resting place: where the scene says the agent belongs. */
export function restSpot(scene: SceneState, agent: CrewAgent): Spot {
  return spotFor(agent, scene.agents[agent].place);
}

/** The legs of an idle plan, starting from wherever the agent is and ending at home. */
export function idleLegs(runId: string, agent: CrewAgent, bucket: number, assignment: Assignment, home: Spot, first: boolean): Leg[] {
  const seed = seedOf(runId, agent, bucket);
  const random = rng(seed);
  const maybe = (texts: readonly string[], from = 0.4): Say | undefined =>
    random() < 0.6 ? { text: pick(texts, seed), from, to: from + 2.4 } : undefined;
  const back: Leg = { spot: home, dwell: 0 };
  switch (assignment.kind) {
    case "rest": {
      if (agent === "lead" && home.seat === "chair") {
        // Back in the office after planning: emails.
        const text = first ? IDLE_PHRASES.emails[0] : pick(IDLE_PHRASES.emails, seed);
        return [{ spot: home, dwell: 0, pose: "type", say: first || random() < 0.5 ? { text, from: 0.3, to: 3.3 } : undefined }];
      }
      return [back];
    }
    case "cooler":
      return [{ spot: IDLE_SPOTS.cooler[agent], dwell: 3.5 + random() * 1.5, pose: "drink", say: maybe(IDLE_PHRASES.cooler) }, back];
    case "sofa":
      return [{ spot: IDLE_SPOTS.sofa[agent], dwell: 5 + random() * 3, pose: "sofa", say: maybe(IDLE_PHRASES.sofa, 1) }, back];
    case "window":
      return [{ spot: IDLE_SPOTS.window[agent], dwell: 4 + random() * 2, pose: "look", say: maybe(IDLE_PHRASES.window, 0.8) }, back];
    case "desk": {
      const seat = spotFor(agent, "desk");
      return [{ spot: seat, dwell: 5 + random() * 3, pose: "scroll", say: maybe(IDLE_PHRASES.desk, 1) }, back];
    }
    case "chat": {
      const [opener, reply] = assignment.line ?? ["Coffee?", "Sure"];
      const spot = CHAT_SPOTS[assignment.opener ? 0 : 1];
      const say: Say = assignment.opener ? { text: opener, from: 0.3, to: 2.1 } : { text: reply, from: 2.2, to: 4 };
      return [{ spot, dwell: 4.5, pose: "talk", say, waitFor: assignment.partner }, back];
    }
  }
}
