// Decides which bubble each agent shows and where it goes on screen. The
// reducer says what an agent last said; this keeps every bubble up long
// enough to read (MIN_HOLD_S at 1x, divided by the replay speed), expires
// short-lived ones, turns coffee breaks into a countdown, and falls back to a
// thought cloud while the agent waits for the model, or to idle chatter.

import type { CrewAgent } from "../types";
import type { Pose } from "./animator";
import { characterTop } from "./characters";
import { TILE, WIDTH } from "./layout";
import { countdownText } from "./phrases";
import type { Bubble } from "./reducer";

export const MIN_HOLD_S = 1.5;
// The replay server caps each gap between events (see server.py MAX_GAP_S).
export const REPLAY_MAX_GAP_S = 2;

export interface ShownBubble {
  key: string;
  text: string;
  style: "speech" | "thought";
}

export interface BubbleInputs {
  // the reducer's current bubble, and the last thing said (kept after the bubble clears)
  bubble: Bubble | null;
  said: Bubble | null;
  thinking: boolean;
  // a line from an errand (trip) or idle office life, from the animator
  say: string | null;
  trip: boolean;
  // the run's clock: the latest applied event's timestamp (ms), if known
  sceneTime?: number | null;
}

interface Slot {
  shown: (ShownBubble & { wait?: number }) | null;
  since: number; // real seconds
  playSince: number; // playback seconds
  // first time each bubble key was shown (for ttl), in playback seconds
  firstShown: Map<string, number>;
  // seq of the newest `said` bubble already shown
  lastSaid: number;
}

export class BubbleDirector {
  private slots = new Map<CrewAgent, Slot>();

  /** Forget everything (after a seek): show the current state at once. */
  reset(): void {
    this.slots.clear();
  }

  private slot(agent: CrewAgent, inputs: BubbleInputs): Slot {
    let slot = this.slots.get(agent);
    if (!slot) {
      // Fresh start (first frame or a seek): only what's current counts, not old lines.
      slot = { shown: null, since: -Infinity, playSince: 0, firstShown: new Map(), lastSaid: inputs.said?.seq ?? -1 };
      this.slots.set(agent, slot);
    }
    return slot;
  }

  /**
   * The bubble to show this frame. `now` is real seconds; `play` is playback
   * seconds (frozen while paused) for ttl and the coffee countdown.
   */
  next(agent: CrewAgent, inputs: BubbleInputs, now: number, play: number, speed: number): ShownBubble | null {
    const slot = this.slot(agent, inputs);
    const hold = MIN_HOLD_S / Math.max(1, speed);
    const candidate = this.candidate(slot, inputs, play, speed);
    const current = slot.shown;
    if (current && candidate?.key === current.key) {
      slot.shown = { ...candidate };
      return this.render(slot, play, speed);
    }
    // Keep the current bubble up for at least `hold` before replacing or hiding it.
    if (current && now - slot.since < hold) return this.render(slot, play, speed);
    slot.shown = candidate;
    slot.since = now;
    slot.playSince = play;
    if (candidate && !slot.firstShown.has(candidate.key)) slot.firstShown.set(candidate.key, play);
    // Whichever way an event's line got shown, its `said` copy is now old news.
    const seq = candidate?.key.startsWith("e:") ? Number(candidate.key.slice(2)) : NaN;
    if (Number.isFinite(seq)) slot.lastSaid = Math.max(slot.lastSaid, seq);
    return candidate ? this.render(slot, play, speed) : null;
  }

  private candidate(slot: Slot, { bubble, said, thinking, say, trip, sceneTime }: BubbleInputs, play: number, speed: number): (ShownBubble & { wait?: number }) | null {
    if (trip && say) return { key: `say:${say}`, text: say, style: "speech" };
    const unseen = said && said.seq > slot.lastSaid ? said : null;
    for (const b of [unseen, bubble]) {
      if (!b) continue;
      const key = `e:${b.seq}`;
      const first = slot.firstShown.get(key);
      // Expired once shown for its ttl, or once the run has moved on past it
      // (a deep link landing long after the line was said).
      const shownLongEnough = first != null && play - first > b.ttl! / Math.max(1, speed);
      const stale = sceneTime != null && b.at != null && (sceneTime - b.at) / 1000 > b.ttl!;
      const expired = b.ttl != null && (shownLongEnough || stale);
      if (!expired) return { key, text: b.text, style: b.style, wait: b.wait };
    }
    if (thinking) return { key: "thought", text: "…", style: "thought" };
    if (say) return { key: `say:${say}`, text: say, style: "speech" };
    return null;
  }

  private render(slot: Slot, play: number, speed: number): ShownBubble {
    const shown = slot.shown!;
    if (shown.wait == null) return { key: shown.key, text: shown.text, style: shown.style };
    // A coffee break: the excuse first, then a countdown that reaches zero
    // around when the replay delivers the next event.
    const intro = MIN_HOLD_S / Math.max(1, speed);
    const elapsed = play - slot.playSince;
    if (elapsed < intro) return { key: shown.key, text: shown.text, style: shown.style };
    const gap = Math.max(0.5, Math.min(shown.wait / Math.max(1, speed), REPLAY_MAX_GAP_S));
    const remaining = shown.wait * Math.max(0, 1 - elapsed / gap);
    return { key: shown.key, text: countdownText(remaining), style: shown.style };
  }
}

// --- placement ---------------------------------------------------------------------------

export interface Anchor {
  // CSS pixels within the canvas box: the point the tail touches
  x: number;
  y: number;
}

/** Where a character's bubble tail should point, in CSS pixels, for a canvas `cssWidth` wide. */
export function bubbleAnchor(px: number, py: number, pose: Pose, cssWidth: number): Anchor {
  const scale = cssWidth / WIDTH;
  return { x: (px + TILE / 2) * scale, y: (py + characterTop(pose) - 2) * scale };
}

export const TAIL_PX = 7;

export interface Box {
  left: number;
  top: number;
  w: number;
  h: number;
}

/**
 * Nudge bubbles up so none overlap: the lowest (nearest the viewer) keeps
 * its place, the others climb above whatever they hit. Returns new tops in
 * the input order.
 */
export function resolveOverlaps(boxes: Box[], gap = 4): number[] {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b].top - boxes[a].top);
  const placed: Box[] = [];
  const tops = boxes.map((b) => b.top);
  for (const i of order) {
    const box = { ...boxes[i] };
    for (let tries = 0; tries < boxes.length; tries++) {
      const hit = placed.find((p) => box.left < p.left + p.w + gap && p.left < box.left + box.w + gap && box.top < p.top + p.h + gap && p.top < box.top + box.h + gap);
      if (!hit) break;
      box.top = hit.top - box.h - gap;
    }
    tops[i] = box.top;
    placed.push(box);
  }
  return tops;
}

/**
 * The bubble's box for its measured size: centred over the anchor, kept
 * inside the canvas, the tail still pointing at the character.
 */
export function placeBubble(anchor: Anchor, width: number, height: number, containerWidth: number): { left: number; top: number; tail: number } {
  const margin = 4;
  const left = Math.max(margin, Math.min(containerWidth - width - margin, anchor.x - width / 2));
  const top = Math.max(margin, anchor.y - height - TAIL_PX);
  const tail = Math.max(10, Math.min(width - 10, anchor.x - left));
  return { left, top, tail };
}
