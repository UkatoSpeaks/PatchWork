import { useMemo } from "react";

import { parseDiff, type DiffFile, type FileRole } from "@/lib/diff";

const STATUS: Record<DiffFile["status"], string | null> = { added: "new", deleted: "deleted", renamed: "renamed", binary: "binary", modified: null };
const ROLE_STYLE: Record<FileRole, string> = { tests: "bg-moss text-on", code: "bg-slate text-on" };

/** The run's final diff, GitHub-style: a header per file, line numbers, green additions, red deletions. */
export default function DiffViewer({ diff, roleOf }: { diff: string; roleOf: (path: string) => FileRole }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  if (!files.length) {
    return <p className="p-2 text-sm text-ink-soft">No diff in this run&apos;s result (it stopped before merging, or it is still running).</p>;
  }
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="flex flex-col gap-4">
      <p className="font-pixel text-sm">
        {files.length} file{files.length === 1 ? "" : "s"} changed, <span className="text-moss">+{additions}</span>{" "}
        <span className="text-terracotta">−{deletions}</span>
      </p>
      {files.map((file, i) => (
        <details key={`${file.path}-${i}`} open className="pixel-box-sm min-w-0 bg-paper">
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 bg-cream-dark px-3 py-2 font-mono text-xs">
            <span className="min-w-0 flex-1 break-all font-bold">
              {file.status === "renamed" ? `${file.oldPath} → ${file.newPath}` : file.path}
            </span>
            <span className={`px-1.5 font-pixel text-[11px] uppercase ${ROLE_STYLE[roleOf(file.path)]}`}>{roleOf(file.path)}</span>
            {STATUS[file.status] && <span className="bg-ink px-1.5 font-pixel text-[11px] uppercase text-paper">{STATUS[file.status]}</span>}
            <span className="text-moss">+{file.additions}</span>
            <span className="text-terracotta">−{file.deletions}</span>
          </summary>
          <div className="pixel-scroll overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[11px] leading-[1.45] [font-variant-ligatures:none]">
              <tbody>
                {file.hunks.map((hunk, h) => (
                  <HunkRows key={h} header={hunk.header} lines={hunk.lines} />
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </div>
  );
}

const ROW: Record<string, string> = { add: "bg-add", del: "bg-del", ctx: "", meta: "text-ink-soft italic" };
const SIGN: Record<string, string> = { add: "+", del: "−", ctx: " ", meta: "" };

function HunkRows({ header, lines }: { header: string; lines: { kind: string; text: string; oldNo: number | null; newNo: number | null }[] }) {
  return (
    <>
      <tr className="bg-hunk text-ink-soft">
        <td colSpan={4} className="px-3 py-0.5">{header}</td>
      </tr>
      {lines.map((line, i) => (
        <tr key={i} className={ROW[line.kind]}>
          <td className="w-10 select-none border-r border-ink/10 px-2 text-right text-ink-soft/80 tabular-nums">{line.oldNo ?? ""}</td>
          <td className="w-10 select-none border-r border-ink/10 px-2 text-right text-ink-soft/80 tabular-nums">{line.newNo ?? ""}</td>
          <td className={`w-4 select-none pl-2 ${line.kind === "add" ? "text-moss" : line.kind === "del" ? "text-terracotta" : ""}`}>{SIGN[line.kind]}</td>
          <td className="whitespace-pre pr-3">{line.text || " "}</td>
        </tr>
      ))}
    </>
  );
}
