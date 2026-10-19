import { describe, expect, it } from "vitest";

import { BubbleDirector, bubbleAnchor, MIN_HOLD_S, placeBubble, resolveOverlaps, type BubbleInputs } from "./bubbles";
import { WIDTH } from "./layout";
import type { Bubble } from "./reducer";

const speech = (seq: number, text: string, extra: Partial<Bubble> = {}): Bubble => ({ seq, text, style: "speech", ...extra });
const inputs = (patch: Partial<BubbleInputs> = {}): BubbleInputs => ({ bubble: null, said: null, thinking: false, say: null, trip: false, ...patch });

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
      const cleared = inputs({ said: speech(1, "Checking ops.py"), thinking: true });
      expect(d.next("coder", cleared, (MIN_HOLD_S / speed) * 0.9, 0, speed)?.text).toBe("Checking ops.py");
      expect(d.next("coder", cleared, (MIN_HOLD_S / speed) * 1.1, 0, speed)?.style).toBe("thought");
    }
  });

  it("shows a line said and cleared between two frames", () => {
    const d = new BubbleDirector();
    d.next("coder", inputs({ thinking: true, said: speech(1, "old") }), 0, 0, 4);
    const shown = d.next("coder", inputs({ thinking: true, said: speech(2, "Editing ops.py") }), 1, 1, 4);
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

  it("turns a coffee break into a countdown", () => {
    const d = new BubbleDirector();
    const coffee = inputs({ bubble: speech(3, "Rate limited. Coffee time ☕", { wait: 12 }) });
    expect(d.next("lead", coffee, 0, 0, 1)?.text).toBe("Rate limited. Coffee time ☕");
    expect(d.next("lead", coffee, 1.6, 1.6, 1)?.text).toMatch(/^☕ \d+s left$/);
  });

  it("prefers news over thinking, and thinking over idle chatter", () => {
    const d = new BubbleDirector();
    expect(d.next("lead", inputs({ say: "Nice view" }), 0, 0, 1)?.text).toBe("Nice view");
    const e = new BubbleDirector();
    expect(e.next("lead", inputs({ say: "Nice view", thinking: true }), 0, 0, 1)?.style).toBe("thought");
    const f = new BubbleDirector();
    expect(f.next("reviewer", inputs({ say: "Can you fix this?", trip: true, bubble: speech(9, "Not yet") }), 0, 0, 1)?.text).toBe("Can you fix this?");
  });
});
