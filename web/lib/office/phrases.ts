// What the crew says, in plain language. Every situation has a few natural
// variants; which one is picked depends only on a seed (run id + event seq),
// so a replay or a deep link (?at=N) always shows the same words.

import type { CrewAgent } from "../types";
import { argsOf, basename, clip, toolName } from "./labels";

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
const file = (path: string) => clip(basename(path), 18);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The function an edit touches, from `def name(` in its new or old text. */
function editedFunction(args: Record<string, unknown>): string | null {
  for (const key of ["new", "new_text", "content", "old", "old_text"]) {
    const value = args[key];
    if (typeof value !== "string") continue;
    const match = value.match(/\bdef\s+([A-Za-z_]\w*)\s*\(/) ?? value.match(/\bclass\s+([A-Za-z_]\w*)/);
    if (match) return match[1];
  }
  return null;
}

function isOneLiner(args: Record<string, unknown>): boolean {
  const a = args.old, b = args.new;
  return typeof a === "string" && typeof b === "string" && !a.trim().includes("\n") && !b.trim().includes("\n");
}

const looksLikeTest = (path: string) => /(^|\/)tests?\/|test_[^/]*$|_test\.\w+$/.test(path.replace(/\\/g, "/"));

/** What an agent says as it calls a tool. */
export function toolPhrase(tool: string, rawArgs: unknown, seed: number): string {
  const args = argsOf(rawArgs);
  const path = typeof args.path === "string" ? args.path : "";
  const name = toolName(tool);
  const f = path ? file(path) : "";
  switch (name) {
    case "read_file":
      return fit(pick(f ? [`Let me look at ${f}…`, `Checking ${f}`, `What's in ${f}?`, `Reading ${f}`] : ["Let me read that…", "Reading a file"], seed));
    case "list_dir": {
      const dir = path ? `${file(path)}/` : "the repo";
      return fit(pick([`What's in ${dir}?`, `Looking around ${dir}`, `Let me see ${dir}`, `Browsing ${dir}`], seed));
    }
    case "search_code": {
      const pattern = clip(String(args.pattern ?? args.query ?? "").trim(), 16);
      if (!pattern) return pick(["Searching the code…", "Where is that used?"], seed);
      return fit(pick([`Where is '${pattern}' used?`, `Searching for ${pattern}…`, `Any '${pattern}' around?`, `Hunting for ${pattern}`], seed));
    }
    case "edit_file":
    case "insert_lines":
    case "replace_lines": {
      const fn = editedFunction(args);
      const options = [f ? `Editing ${f}` : "Editing the code", f ? `Patching ${f}` : "Patching things up"];
      if (fn) options.push(`Fixing ${clip(fn, 20)}()`, `Updating ${clip(fn, 20)}()`);
      if (isOneLiner(args)) options.push("One-line fix, nice");
      return fit(pick(options, seed));
    }
    case "write_file":
      if (looksLikeTest(path)) return fit(pick(["Writing tests first", "These should fail for now", f ? `Writing ${f}` : "Writing a test file", "Test time!"], seed));
      return fit(pick(f ? [`Writing ${f}`, `New file: ${f}`, `Creating ${f}`] : ["Writing a new file"], seed));
    case "run_tests":
      return pick(["Running the tests…", "Let's run the tests", "Fingers crossed…", "Test run, here we go"], seed);
    case "submit_plan":
      return pick(["Here's the plan", "Plan's ready", "Okay, here's the plan"], seed);
    case "submit_review":
      return pick(["Writing up my review", "Okay, my verdict…", "Review notes, done"], seed);
    case "finish":
      return pick(["Wrapping up", "That should do it", "Let me wrap this up"], seed);
    default:
      return fit(name ? `${name.replace(/_/g, " ")}…` : "Working on it…");
  }
}

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

export const toolErrorPhrase = (seed: number) => pick(["Hmm, that didn't work", "Oops, let me retry", "That's odd…"], seed);

/** "groq/openai/gpt-oss-120b" -> "Groq" */
export function providerName(model: unknown): string {
  const first = String(model ?? "").split("/")[0];
  if (!first) return "The API";
  const known: Record<string, string> = { groq: "Groq", openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini", ollama: "Ollama" };
  return known[first.toLowerCase()] ?? first.charAt(0).toUpperCase() + first.slice(1);
}

/** The first thing said on the way to the coffee machine. */
export function coffeePhrase(kind: "rate_limited" | "throttled", model: unknown, seed: number): string {
  const provider = providerName(model);
  const options =
    kind === "rate_limited"
      ? ["Rate limited. Coffee time ☕", `${provider} needs a break, so do I`, "Too many requests. Coffee ☕", "Quota hit. Coffee break ☕"]
      : ["Pacing myself. Coffee ☕", `${provider} needs a break, so do I`, "Saving tokens. Coffee time ☕", "Token budget's low. Coffee ☕"];
  return fit(pick(options, seed));
}

export const countdownText = (seconds: number) => `☕ ${Math.max(0, Math.ceil(seconds))}s left`;

export const shortWaitPhrase = (seed: number) => pick(["One sec…", "Just a moment…", "Hold on…"], seed);

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
