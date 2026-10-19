// A unified-diff parser for the diff viewer (result.json's `diff`, from git
// diff), plus which files are the tester's tests and which the coder's code.

import type { RunEvent } from "./types";

export type DiffLineKind = "add" | "del" | "ctx" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  // the path to show: the new one, or the old one for a deletion
  path: string;
  status: "added" | "deleted" | "modified" | "renamed" | "binary";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

const stripPrefix = (path: string) => path.replace(/^[ab]\//, "");

function newFile(oldPath = "", newPath = ""): DiffFile {
  return { oldPath, newPath, path: newPath || oldPath, status: "modified", hunks: [], additions: 0, deletions: 0 };
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  // line numbers, and how many old/new lines the current hunk still has
  let oldNo = 0, newNo = 0, oldLeft = 0, newLeft = 0;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const f = file!;
      if (line.startsWith("+")) {
        hunk.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
        f.additions++;
        newLeft--;
        continue;
      }
      if (line.startsWith("-")) {
        hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
        f.deletions++;
        oldLeft--;
        continue;
      }
      if (line.startsWith(" ") || line === "") {
        hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
    }
    if (line.startsWith("\\")) {
      // "\ No newline at end of file" belongs to the hunk just read
      hunk?.lines.push({ kind: "meta", text: line.slice(1).trim(), oldNo: null, newNo: null });
      continue;
    }
    const git = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (git) {
      file = newFile(git[1], git[2]);
      files.push(file);
      hunk = null;
      continue;
    }
    const range = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (range) {
      if (!file) {
        file = newFile();
        files.push(file);
      }
      oldNo = Number(range[1]);
      oldLeft = range[2] == null ? 1 : Number(range[2]);
      newNo = Number(range[3]);
      newLeft = range[4] == null ? 1 : Number(range[4]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (line.startsWith("--- ")) {
      // A plain unified diff has no "diff --git" line: "---" starts the next file.
      if (!file || file.hunks.length > 0) {
        file = newFile();
        files.push(file);
      }
      const path = line.slice(4).trim();
      if (path === "/dev/null") file.status = "added";
      else file.oldPath = stripPrefix(path);
      file.path = file.newPath || file.oldPath;
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      if (path === "/dev/null") {
        file.status = "deleted";
        file.newPath = "";
      } else file.newPath = stripPrefix(path);
      file.path = file.newPath || file.oldPath;
    } else if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      file.newPath = line.slice("rename to ".length);
      file.path = file.newPath;
    } else if (line.startsWith("Binary files")) file.status = "binary";
  }
  return files;
}

export type FileRole = "tests" | "code";

const looksLikeTest = (path: string) => /(^|\/)tests?\/|(^|\/)test_[^/]*$|_test\.\w+$|\.test\.\w+$/.test(path);

/**
 * Which files are tests (the tester's) and which are code (the coder's): from
 * the merge events' file lists per branch, then the run result, then the path.
 */
export function fileRoles(events: RunEvent[], result: Record<string, any> | null): (path: string) => FileRole {
  const roles = new Map<string, FileRole>();
  const mark = (paths: unknown, role: FileRole) => {
    if (Array.isArray(paths)) for (const p of paths) if (typeof p === "string" && !roles.has(p)) roles.set(p, role);
  };
  for (const event of events) {
    const p = event.payload ?? {};
    if (event.type === "merge") mark(p.files, String(p.branch ?? "").endsWith("/tester") ? "tests" : "code");
    if (event.type === "agent_finished" && event.agent === "tester") mark(p.tests_written, "tests");
    if (event.type === "agent_finished" && event.agent === "coder") mark(p.files, "code");
  }
  mark(result?.tests_written, "tests");
  return (path) => roles.get(path) ?? (looksLikeTest(path) ? "tests" : "code");
}
