// Helpers for turning tool calls into short text: file names, clipped strings
// and tolerant parsing of tool arguments.

export function basename(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return clean.split("/").pop() || clean;
}

/** Shorten to `max` characters, ending in an ellipsis when cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** Tool arguments are an object, but tolerate a JSON or Python-repr string. */
export function argsOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Python repr: pick out 'key': 'value' pairs.
  }
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(/['"](\w+)['"]\s*:\s*['"]([^'"]*)['"]/g)) out[match[1]] = match[2];
  return out;
}

/** "repo_browser.list_dir" -> "list_dir" */
export function toolName(tool: unknown): string {
  return String(tool ?? "").replace(/^.*\./, "");
}

/** The path argument of a tool call, or "". */
export function pathArg(rawArgs: unknown): string {
  const args = argsOf(rawArgs);
  return typeof args.path === "string" ? args.path : "";
}
