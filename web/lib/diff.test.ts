import { describe, expect, it } from "vitest";

import { fileRoles, parseDiff } from "./diff";
import type { RunEvent } from "./types";

const DIFF = `diff --git a/tests/test_slugify.py b/tests/test_slugify.py
new file mode 100644
index 0000000..cff7ac0
--- /dev/null
+++ b/tests/test_slugify.py
@@ -0,0 +1,3 @@
+import pytest
+
+from text_utils import slugify
diff --git a/text_utils/__init__.py b/text_utils/__init__.py
index 8127bec..42f7258 100644
--- a/text_utils/__init__.py
+++ b/text_utils/__init__.py
@@ -1,5 +1,5 @@
 """Small text helpers."""

-from text_utils.core import truncate
+from text_utils.core import truncate, slugify

---- a line that starts with dashes
+--- added dashes
\\ No newline at end of file
diff --git a/old.py b/old.py
deleted file mode 100644
--- a/old.py
+++ /dev/null
@@ -1 +0,0 @@
-gone = True
`;

describe("parseDiff", () => {
  const files = parseDiff(DIFF);

  it("splits files and reads their headers", () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["tests/test_slugify.py", "added"],
      ["text_utils/__init__.py", "modified"],
      ["old.py", "deleted"],
    ]);
  });

  it("numbers add, remove and context lines like GitHub", () => {
    const [added, changed, deleted] = files;
    expect(added.additions).toBe(3);
    expect(added.hunks[0].lines[0]).toEqual({ kind: "add", text: "import pytest", oldNo: null, newNo: 1 });
    const lines = changed.hunks[0].lines;
    expect(lines[0]).toEqual({ kind: "ctx", text: '"""Small text helpers."""', oldNo: 1, newNo: 1 });
    expect(lines[1]).toMatchObject({ kind: "ctx", text: "", oldNo: 2, newNo: 2 });
    expect(lines[2]).toEqual({ kind: "del", text: "from text_utils.core import truncate", oldNo: 3, newNo: null });
    expect(lines[3]).toEqual({ kind: "add", text: "from text_utils.core import truncate, slugify", oldNo: null, newNo: 3 });
    // a removed line that itself starts with "---" is still a removed line
    expect(lines[5]).toMatchObject({ kind: "del", text: "--- a line that starts with dashes", oldNo: 5 });
    expect(lines[6]).toMatchObject({ kind: "add", text: "--- added dashes", newNo: 5 });
    expect(lines[7]).toMatchObject({ kind: "meta", text: "No newline at end of file" });
    expect([changed.additions, changed.deletions]).toEqual([2, 2]);
    expect(deleted.hunks[0].lines).toEqual([{ kind: "del", text: "gone = True", oldNo: 1, newNo: null }]);
  });

  it("handles a plain unified diff and empty input", () => {
    expect(parseDiff("")).toEqual([]);
    const plain = parseDiff("--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b\n--- a/y.py\n+++ b/y.py\n@@ -2 +2 @@\n-c\n+d\n");
    expect(plain.map((f) => f.path)).toEqual(["x.py", "y.py"]);
    expect(plain[1].hunks[0].lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([["del", 2, null], ["add", null, 2]]);
  });
});

describe("fileRoles", () => {
  it("labels the tester's files tests and the coder's code", () => {
    const merge = (branch: string, files: string[]): RunEvent =>
      ({ run_id: "r", seq: 1, timestamp: "", agent: "orchestrator", type: "merge", payload: { branch, files } });
    const roleOf = fileRoles([merge("patchwork/r/tester", ["tests/test_slugify.py"]), merge("patchwork/r/coder", ["text_utils/core.py"])], null);
    expect(roleOf("tests/test_slugify.py")).toBe("tests");
    expect(roleOf("text_utils/core.py")).toBe("code");
    expect(roleOf("tests/test_other.py")).toBe("tests"); // by path when nobody claimed it
    expect(roleOf("README.md")).toBe("code");
  });
});
