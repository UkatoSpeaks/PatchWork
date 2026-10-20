import { describe, expect, it } from "vitest";

import { BubbleDirector, bubbleAnchor, countdown, layoutOverlay, MIN_HOLD_S, overlaps, placeBubble, resolveOverlaps, TAIL_PX, type BubbleInputs, type OverlayItem } from "./bubbles";
import { WIDTH } from "./layout";
import type { Bubble } from "./reducer";

const speech = (seq: number, text: string, extra: Partial<Bubble> = {}): Bubble => ({ seq, text, style: "speech", ...extra });
const inputs = (patch: Partial<BubbleInputs> = {}): BubbleInputs => ({ bubble: null, said: null, say: null, trip: false, ...patch });

describe("bubble placement", () => {
  it("scales with the canvas size", () => {
    const small = bubbleAnchor(160, 208, "stand", WIDTH);
    const big = bubbleAnchor(160, 208, "stand", WIDTH * 2.5);
    expect(big.x).toBeCloseTo(small.x * 2.5);
    expect(big.y).toBeCloseTo(small.y * 2.5);
    // centred over the character, above its head
    expect(small.x).toBe(168);
    expect(small.y).toBeLessThan(208);
  });

  it("sits lower for seated characters", () => {
    expect(bubbleAnchor(160, 208, "type", WIDTH).y).toBeGreaterThan(bubbleAnchor(160, 208, "stand", WIDTH).y);
  });

  it("stays inside the canvas with its tail on the character", () => {
    const { left, top, tail } = placeBubble({ x: 10, y: 100 }, 120, 30, 600);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(100 - 30);
    expect(left + tail).toBeCloseTo(10, -1);
    const right = placeBubble({ x: 595, y: 100 }, 120, 30, 600);
    expect(right.left + 120).toBeLessThanOrEqual(600);
  });

  it("stacks neighbours instead of overlapping them", () => {
    const tops = resolveOverlaps([
      { left: 100, top: 50, w: 120, h: 30 },
      { left: 140, top: 52, w: 120, h: 30 },
      { left: 400, top: 50, w: 80, h: 30 },
    ]);
    const [a, b] = [tops[0], tops[1]];
    expect(Math.abs(a - b)).toBeGreaterThanOrEqual(30);
    expect(tops[2]).toBe(50); // far away: untouched
  });
});

describe("BubbleDirector", () => {
  it("keeps a line up for at least 1.5s at 1x, scaled by speed", () => {
    for (const speed of [1, 4]) {
      const d = new BubbleDirector();
      expect(d.next("coder", inputs({ bubble: speech(1, "Checking ops.py") }), 0, 0, speed)?.text).toBe("Checking ops.py");
      // cleared right away by the next event: still shown until the hold is over
      const cleared = inputs({ said: speech(1, "Checking ops.py") });
      expect(d.next("coder", cleared, (MIN_HOLD_S / speed) * 0.9, 0, speed)?.text).toBe("Checking ops.py");
      expect(d.next("coder", cleared, (MIN_HOLD_S / speed) * 1.1, 0, speed)).toBeNull();
    }
  });

  it("shows a line said and cleared between two frames", () => {
    const d = new BubbleDirector();
    d.next("coder", inputs({ said: speech(1, "old") }), 0, 0, 4);
    const shown = d.next("coder", inputs({ said: speech(2, "Editing ops.py") }), 1, 1, 4);
    expect(shown?.text).toBe("Editing ops.py");
  });

  it("expires short-lived lines, and stale ones on a deep link", () => {
    const d = new BubbleDirector();
    const done = speech(5, "Done ✓", { ttl: 3, at: 1_000_000 });
    expect(d.next("tester", inputs({ bubble: done, sceneTime: 1_000_500 }), 0, 0, 1)?.text).toBe("Done ✓");
    expect(d.next("tester", inputs({ bubble: done, sceneTime: 1_000_500 }), 4, 4, 1)).toBeNull();
    const deepLink = new BubbleDirector();
    expect(deepLink.next("tester", inputs({ bubble: done, sceneTime: 1_020_000 }), 0, 0, 1)).toBeNull();
  });

  it("counts a provider wait down to zero by about when the replay moves on", () => {
    expect(countdown(12, 0, 1)).toBe(12);
    // at 4x, a 12s wait is compressed into the replay's 2s maximum gap
    expect(countdown(12, 1, 4)).toBeCloseTo(6);
    expect(countdown(12, 2.5, 4)).toBe(0);
  });

  it("prefers news over idle chatter, and never shows a thought cloud", () => {
    const d = new BubbleDirector();
    expect(d.next("lead", inputs({ say: "Nice view" }), 0, 0, 1)?.text).toBe("Nice view");
    const e = new BubbleDirector();
    expect(e.next("lead", inputs({ say: "Nice view", bubble: speech(4, "Done ✓") }), 0, 0, 1)?.text).toBe("Done ✓");
    expect(new BubbleDirector().next("coder", inputs(), 0, 0, 1)).toBeNull();
    const f = new BubbleDirector();
    expect(f.next("reviewer", inputs({ say: "Can you fix this?", trip: true, bubble: speech(9, "Not yet") }), 0, 0, 1)?.text).toBe("Can you fix this?");
  });
});

describe("status tags and bubbles together", () => {
  const item = (agent: OverlayItem["agent"], x: number, y: number, tag = true, bubble = false): OverlayItem => ({
    agent, anchor: { x, y }, tag: tag ? { w: 150, h: 30 } : null, bubble: bubble ? { w: 120, h: 24 } : null,
  });
  const boxesOf = (placed: ReturnType<typeof layoutOverlay>, items: OverlayItem[]) =>
    items.flatMap((i) => [
      ...(placed[i.agent]?.tag ? [{ agent: i.agent, kind: "tag", left: placed[i.agent]!.tag!.left, top: placed[i.agent]!.tag!.top, w: i.tag!.w, h: i.tag!.h }] : []),
      ...(placed[i.agent]?.bubble ? [{ agent: i.agent, kind: "bubble", left: placed[i.agent]!.bubble!.left, top: placed[i.agent]!.bubble!.top, w: i.bubble!.w, h: i.bubble!.h + TAIL_PX }] : []),
    ]);

  it("puts the tag just above the head and the bubble above the tag", () => {
    const items = [item("coder", 300, 400, true, true)];
    const placed = layoutOverlay(items, 1000).coder!;
    expect(placed.tag!.top + 30).toBeLessThanOrEqual(400);
    expect(placed.tag!.stem).toBeGreaterThanOrEqual(0);
    expect(placed.tag!.stem).toBeLessThan(6);
    expect(placed.bubble!.top + 24 + TAIL_PX).toBeLessThanOrEqual(placed.tag!.top);
  });

  it("stacks tags of agents that are close, so none overlap", () => {
    // the reviewer standing beside the coder's desk, both with tags and bubbles
    const items = [item("coder", 300, 400, true, true), item("reviewer", 340, 400, true, true), item("tester", 330, 395)];
    const placed = layoutOverlay(items, 1000);
    const boxes = boxesOf(placed, items);
    expect(boxes).toHaveLength(5);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      expect(overlaps(boxes[i], boxes[j]), `${boxes[i].agent} ${boxes[i].kind} vs ${boxes[j].agent} ${boxes[j].kind}`).toBe(false);
    }
    // each bubble is still above its own agent's tag, and every stem reaches its head
    for (const agent of ["coder", "reviewer"] as const) expect(placed[agent]!.bubble!.top).toBeLessThan(placed[agent]!.tag!.top);
    for (const i of items) expect(placed[i.agent]!.tag!.top + 30 + placed[i.agent]!.tag!.stem).toBeCloseTo(i.anchor.y);
  });

  it("leaves agents far apart where they are, and handles agents without a tag", () => {
    const items = [item("lead", 100, 200), item("reviewer", 800, 200, false, true)];
    const placed = layoutOverlay(items, 1000);
    expect(placed.lead!.tag!.top).toBe(200 - 30 - 3);
    expect(placed.reviewer!.tag).toBeNull();
    expect(placed.reviewer!.bubble!.top).toBe(200 - 24 - TAIL_PX);
  });
});
