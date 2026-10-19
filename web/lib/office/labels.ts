// Short speech-bubble labels for tool calls: "reading ops.py", "running tests".

const MAX = 20;

function basename(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return clean.split("/").pop() || clean;
}

function clip(text: string, max = MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 2)}..`;
}

/** Tool arguments are an object, but tolerate a JSON or Python-repr string. */
function argsOf(raw: unknown): Record<string, unknown> {
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

export function toolLabel(tool: string, rawArgs: unknown): string {
  const args = argsOf(rawArgs);
  const path = typeof args.path === "string" ? args.path : "";
  const name = tool.replace(/^.*\./, ""); // "repo_browser.list_dir" -> "list_dir"
  const file = path ? basename(path) : "";
  switch (name) {
    case "read_file":
      return clip(`reading ${file || "a file"}`);
    case "list_dir":
      return clip(`looking in ${file ? `${file}/` : "repo"}`);
    case "search_code":
      return clip(`searching '${String(args.pattern ?? "").slice(0, 9)}'`);
    case "edit_file":
    case "insert_lines":
      return clip(`editing ${file || "code"}`);
    case "write_file":
      return clip(`writing ${file || "a file"}`);
    case "run_tests":
      return "running tests";
    case "submit_plan":
      return "posting the plan";
    case "submit_review":
      return "posting review";
    case "finish":
      return "wrapping up";
    default:
      return clip(name.replace(/_/g, " ") || "working");
  }
}
