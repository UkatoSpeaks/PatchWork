// What the crew says, in plain language. Every situation has a few natural
// variants; which one is picked depends only on a seed (run id + event seq),
// so a replay or a deep link (?at=N) always shows the same words.

import type { CrewAgent } from "../types";
import { clip } from "./labels";

export const MAX_BUBBLE_CHARS = 40;

/** FNV-1a over the parts: a stable 32-bit seed. */
export function seedOf(...parts: (string | number | null | undefined)[]): number {
  let hash = 0x811c9dc5;
  for (const ch of parts.map((p) => String(p ?? "")).join("␟")) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A small deterministic PRNG (mulberry32) for picks that need several draws. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(options: readonly T[], seed: number): T {
  return options[seed % options.length];
}

const fit = (text: string) => clip(text, MAX_BUBBLE_CHARS);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** pytest-style "3 failed, 7 passed, 1 error" -> counts. */
export function testCounts(summary: string): { passed: number | null; failed: number | null } {
  const count = (pattern: RegExp) => {
    const match = summary.match(pattern);
    return match ? Number(match[1]) : null;
  };
  const failed = count(/(\d+) failed/);
  const errors = count(/(\d+) errors?\b/);
  return {
    passed: count(/(\d+) passed/),
    failed: failed == null && errors == null ? null : (failed ?? 0) + (errors ?? 0),
  };
}

/** What an agent says when its test run comes back. */
export function testResultPhrase(agent: CrewAgent, summary: string, passed: boolean, seed: number): string {
  const { passed: ok, failed } = testCounts(summary);
  if (passed) {
    const options = ["All green! ✅", "Tests pass! ✅", "Green across the board ✅"];
    if (ok) options.push(`${ok} passed, all green ✅`);
    return pick(options, seed);
  }
  const n = failed ?? 0;
  if (agent === "tester") {
    const options = ["Red, as it should be", "Failing first, as planned"];
    if (n) options.push(`${n} failing, as expected`, `${n} failing. Good, for now`);
    return pick(options, seed);
  }
  const options = ["Not green yet", "Hmm, still red"];
  if (n) options.push(`Still ${n} failing, hmm`, `${n} failing… let me look`);
  return pick(options, seed);
}

/** "groq/openai/gpt-oss-120b" -> "Groq" */
export function providerName(model: unknown): string {
  const first = String(model ?? "").split("/")[0];
  if (!first) return "The API";
  const known: Record<string, string> = { groq: "Groq", openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini", ollama: "Ollama" };
  return known[first.toLowerCase()] ?? first.charAt(0).toUpperCase() + first.slice(1);
}

export function startPhrase(agent: CrewAgent, label: string, phase: string | null, seed: number): string {
  if (/retry/i.test(label)) return pick(["On it", "Sure, fixing it now", "On it, one sec"], seed);
  if (/round\s*[2-9]/i.test(label)) return pick(["Let's see the fixes", "Second look…", "Okay, round two"], seed);
  switch (agent) {
    case "lead":
      return pick(phase === "plan" ? ["Let me read the issue", "Okay, what's the ask?", "New issue, let's see"] : ["Let me take a look"], seed);
    case "tester":
      return pick(["Tests first!", "Let's write some tests", "Time to break things"], seed);
    case "coder":
      return pick(["Let's write some code", "Okay, coding time", "Let me find the spot"], seed);
    case "reviewer":
      return pick(["Let me review this", "Review time 🔍", "Let's see the changes"], seed);
  }
}

/** "3 tasks: 1 for tests, 2 for code" from the lead's plan. */
export function planPhrase(subtasks: { role?: string }[], seed: number): string {
  const tests = subtasks.filter((s) => s.role === "tester").length;
  const code = subtasks.filter((s) => s.role === "coder").length;
  return fit(pick([`${plural(subtasks.length, "task")}: ${tests} for tests, ${code} for code`, `${plural(subtasks.length, "task")}. Let's go!`], seed));
}

export function verdictPhrase(approved: boolean, issues: number, seed: number): string {
  if (!approved) return pick(["Not yet, see my notes", "Needs another pass", "Almost, a few fixes needed"], seed);
  if (issues > 0) return pick(["Approved, a couple of nits", "Good, just a few nits", "Approved, minor notes"], seed);
  return pick(["Looks good to me 👍", "Ship it 👍", "LGTM 👍", "Nice work, approved 👍"], seed);
}

/** "groq/openai/gpt-oss-120b" -> "gpt-oss-120b" */
export const modelName = (model: unknown): string => String(model ?? "").split("/").pop() || "";

/** An agent moving to its next model (daily limit, or the provider kept rejecting requests). */
export function modelSwitchPhrase(model: unknown, seed: number): string {
  const name = clip(modelName(model), 24);
  const options = ["Let me try a different brain", "New brain, same plan 🧠"];
  if (name) options.unshift(`Switching to ${name} 🧠`);
  return fit(pick(options, seed));
}

/** The implement-phase coder failed; a retry follows. */
/** An attempt ended early because the agent kept repeating itself. */
export const stuckPhrase = (seed: number) => pick(["I'm going in circles…", "I'm going in circles… stopping"], seed);

/** An edit left unreachable code behind (the harness warned about it). */
export const deadCodePhrase = (seed: number) => pick(["Oops, dead code", "Oops, dead code. Fixing it"], seed);

export const helpPhrase = (seed: number) => pick(["I'm stuck… can someone help?", "Stuck. A second pair of eyes?", "I need a hand here…"], seed);

/** A coder retry on a bigger model (CODER_RETRY_MODEL). */
export const escalatedRetryPhrase = (seed: number) => pick(["Bigger model, second try", "Bigger brain, let's go 🧠", "Second try, bigger model"], seed);

export const retryAskPhrase = (seed: number) => pick(["Can you fix this?", "Got a minute? A few notes", "Small fix needed here"], seed);

export function finishPhrase(outcome: "done" | "failed" | "cancelled", seed: number): string {
  if (outcome === "done") return pick(["Done ✓", "All done ✓", "Finished ✓"], seed);
  if (outcome === "failed") return pick(["I'm stuck…", "I can't crack this one…", "Out of ideas…"], seed);
  return pick(["Never mind", "Okay, stopping", "Never mind, then"], seed);
}

export function mergePhrase(agent: CrewAgent, ok: boolean, seed: number): string {
  if (!ok) return pick(["Uh oh, a merge conflict", "That didn't merge…"], seed);
  return pick(agent === "tester" ? ["Merging my tests", "Merging my branch"] : ["Merging my code", "Merging my branch"], seed);
}

export const celebratePhrase = (seed: number) => pick(["We did it! 🎉", "Merged and green! 🎉", "Great job, team! 🎉"], seed);

// --- idle office life ------------------------------------------------------------

export const IDLE_PHRASES = {
  emails: ["Checking emails", "Inbox zero, almost", "Answering emails"],
  cooler: ["Water break", "Staying hydrated", "Ahh, cold water"],
  coffee: ["Coffee time ☕", "One more coffee", "Fresh pot!"],
  window: ["Nice view", "Looks like rain", "Sunny out there"],
  sofa: ["Quick breather", "Ahh, comfy", "Five minutes…"],
  desk: ["Just scrolling", "Reading the news", "Catching up on chat"],
} as const;

export const CHATS: readonly [string, string][] = [
  ["Coffee?", "Sure"],
  ["How's it going?", "Busy, busy"],
  ["Seen the build?", "Green so far"],
  ["Lunch later?", "Definitely"],
  ["Nice weather, huh", "Finally!"],
];
