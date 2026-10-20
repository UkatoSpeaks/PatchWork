// Decides which speech bubble each agent shows and where it and the status tag
// go on screen. The reducer says what an agent last said (moments only: a
// result, a handoff, a model switch, finishing); this keeps every bubble up
// long enough to read (MIN_HOLD_S at 1x, divided by the replay speed),
// expires short-lived ones, and falls back to idle chatter.

import type { CrewAgent } from "../types";
import type { Pose } from "./animator";
import { characterTop } from "./characters";
import { TILE, WIDTH } from "./layout";
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
  // a line from an errand (trip) or idle office life, from the animator
  say: string | null;
  trip: boolean;
  // the run's clock: the latest applied event's timestamp (ms), if known
  sceneTime?: number | null;
}

interface Slot {
  shown: ShownBubble | null;
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
      return slot.shown;
    }
    // Keep the current bubble up for at least `hold` before replacing or hiding it.
    if (current && now - slot.since < hold) return current;
    slot.shown = candidate;
    slot.since = now;
    slot.playSince = play;
    if (candidate && !slot.firstShown.has(candidate.key)) slot.firstShown.set(candidate.key, play);
    // Whichever way an event's line got shown, its `said` copy is now old news.
    const seq = candidate?.key.startsWith("e:") ? Number(candidate.key.slice(2)) : NaN;
    if (Number.isFinite(seq)) slot.lastSaid = Math.max(slot.lastSaid, seq);
    return candidate;
  }

  private candidate(slot: Slot, { bubble, said, say, trip, sceneTime }: BubbleInputs, play: number, speed: number): ShownBubble | null {
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
      if (!expired) return { key, text: b.text, style: b.style };
    }
    if (say) return { key: `say:${say}`, text: say, style: "speech" };
    return null;
  }
}

/**
 * Seconds left of a provider wait of `wait` seconds, `elapsed` playback
 * seconds after it started. Replays compress gaps between events (at most
 * REPLAY_MAX_GAP_S), so the countdown reaches zero about when the replay
 * delivers the next event.
 */
export function countdown(wait: number, elapsed: number, speed: number): number {
  const gap = Math.max(0.5, Math.min(wait / Math.max(1, speed), REPLAY_MAX_GAP_S));
  return wait * Math.max(0, 1 - elapsed / gap);
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
  // placed first and never moved (status tags, when placing bubbles)
  fixed?: boolean;
}

/** Whether two boxes overlap, or come closer than `gap`. */
export const overlaps = (a: Box, b: Box, gap = 0) =>
  a.left < b.left + b.w + gap && b.left < a.left + a.w + gap && a.top < b.top + b.h + gap && b.top < a.top + a.h + gap;

/**
 * Nudge boxes up so none overlap: fixed boxes and then the lowest (nearest
 * the viewer) keep their place, the others climb above whatever they hit.
 * Returns new tops in the input order.
 */
export function resolveOverlaps(boxes: Box[], gap = 4): number[] {
  const order = boxes.map((_, i) => i).sort((a, b) => Number(!!boxes[b].fixed) - Number(!!boxes[a].fixed) || boxes[b].top - boxes[a].top);
  const placed: Box[] = [];
  const tops = boxes.map((b) => b.top);
  for (const i of order) {
    const box = { ...boxes[i] };
    for (let tries = 0; tries <= boxes.length && !box.fixed; tries++) {
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

// Space between the head and its status tag (a stem joins them when tags stack).
export const TAG_GAP = 3;
const MARGIN = 4;

export interface OverlayItem {
  agent: CrewAgent;
  // the top of the character's head
  anchor: Anchor;
  // measured sizes, when the agent has a status tag / a speech bubble right now
  tag: { w: number; h: number } | null;
  bubble: { w: number; h: number } | null;
}

export interface OverlayPlacement {
  // stem: the gap between the tag's bottom and the head
  tag: { left: number; top: number; stem: number } | null;
  bubble: { left: number; top: number; tail: number } | null;
}

/**
 * Where every status tag and speech bubble goes. A tag sits just above its
 * agent's head and a bubble above the tag (or the head, without one). When
 * agents are close, tags stack upwards so none overlap, then bubbles climb
 * above anything they would cover; a tag never moves for a bubble.
 */
export function layoutOverlay(items: OverlayItem[], containerWidth: number): Partial<Record<CrewAgent, OverlayPlacement>> {
  const centred = (x: number, w: number) => Math.max(MARGIN, Math.min(containerWidth - w - MARGIN, x - w / 2));
  const withTag = items.filter((i) => i.tag);
  const tagBoxes: Box[] = withTag.map(({ anchor, tag }) => ({ left: centred(anchor.x, tag!.w), top: anchor.y - tag!.h - TAG_GAP, w: tag!.w, h: tag!.h }));
  const tagTops = resolveOverlaps(tagBoxes, 2);
  const out: Partial<Record<CrewAgent, OverlayPlacement>> = {};
  withTag.forEach((item, i) => {
    tagBoxes[i] = { ...tagBoxes[i], top: tagTops[i], fixed: true };
    out[item.agent] = { tag: { left: tagBoxes[i].left, top: tagTops[i], stem: item.anchor.y - (tagTops[i] + item.tag!.h) }, bubble: null };
  });
  const withBubble = items.filter((i) => i.bubble);
  const bubbles = withBubble.map((item) => {
    const base = out[item.agent]?.tag ? out[item.agent]!.tag!.top - 1 : item.anchor.y;
    return placeBubble({ x: item.anchor.x, y: base }, item.bubble!.w, item.bubble!.h, containerWidth);
  });
  const all: Box[] = [...tagBoxes, ...bubbles.map((b, i) => ({ left: b.left, top: b.top, w: withBubble[i].bubble!.w, h: withBubble[i].bubble!.h + TAIL_PX }))];
  const tops = resolveOverlaps(all);
  withBubble.forEach((item, i) => {
    out[item.agent] = { tag: out[item.agent]?.tag ?? null, bubble: { ...bubbles[i], top: tops[tagBoxes.length + i] } };
  });
  for (const item of items) out[item.agent] ??= { tag: null, bubble: null };
  return out;
}
