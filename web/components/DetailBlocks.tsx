import type { Block, Tone } from "@/lib/eventDetail";

import CopyButton from "./CopyButton";

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "",
  good: "text-moss",
  bad: "text-terracotta",
  wait: "text-wait",
};

export const TONE_PILL: Record<Tone, string> = {
  neutral: "bg-cream-dark text-ink",
  good: "bg-moss text-on",
  bad: "bg-terracotta text-on",
  wait: "bg-mustard text-onlight",
};

const TONE_EDGE: Record<Tone, string> = {
  neutral: "border-ink/25",
  good: "border-moss",
  bad: "border-terracotta",
  wait: "border-mustard",
};

const CODE_STYLE = {
  del: { box: "bg-del", gutter: "text-terracotta/70", sign: "−" },
  add: { box: "bg-add", gutter: "text-moss/80", sign: "+" },
  plain: { box: "bg-term text-term-text", gutter: "text-term-text/40", sign: "" },
} as const;

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="font-pixel text-[11px] uppercase tracking-wider text-ink-soft">{children}</h3>;
}

/** A block of code or output with a title bar, a copy button and, when known, line numbers. */
export function CodeBlock({ title, text, flavor, startLine }: { title: string; text: string; flavor?: "del" | "add" | "plain"; startLine?: number }) {
  const style = flavor ? CODE_STYLE[flavor] : { box: "bg-cream/70", gutter: "text-ink-soft/60", sign: "" };
  const lines = text.replace(/\n$/, "").split("\n");
  const numbered = startLine != null && startLine > 0;
  return (
    <div className="pixel-box-sm min-w-0">
      <div className="flex items-center justify-between gap-2 bg-cream-dark px-2 py-1">
        <Heading>{title}</Heading>
        <span className="ml-auto font-pixel text-[11px] text-ink-soft">{lines.length} line{lines.length === 1 ? "" : "s"}</span>
        <CopyButton text={text} />
      </div>
      <div className={`pixel-scroll max-h-[22rem] overflow-auto ${style.box}`}>
        <pre className="min-w-max py-1.5 font-mono text-[11px] leading-[1.5] [font-variant-ligatures:none]">
          {lines.map((line, i) => (
            <div key={i} className="flex">
              <span aria-hidden className={`w-10 shrink-0 select-none pr-2 text-right tabular-nums ${style.gutter}`}>
                {numbered ? startLine + i : style.sign}
              </span>
              <span className="whitespace-pre pr-3">{line || " "}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

/** Renders the blocks of an event detail. */
export default function DetailBlocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "fields":
            if (!block.items.length) return null;
            return (
              <section key={i} className="flex flex-col gap-2">
                {block.title && <Heading>{block.title}</Heading>}
                <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                  {block.items.map((item) => (
                    <div key={item.label} className="contents">
                      <dt className="font-pixel text-xs leading-5 text-ink-soft">{item.label}</dt>
                      <dd className={`min-w-0 break-words ${item.mono ? "font-mono text-xs leading-5" : ""} ${item.tone ? TONE_TEXT[item.tone] : ""}`}>{item.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          case "code":
            return <CodeBlock key={i} title={block.title} text={block.text} flavor={block.flavor} startLine={block.startLine} />;
          case "text":
            if (!block.text.trim()) return null;
            return (
              <section key={i} className="flex flex-col gap-1.5">
                {block.title && <Heading>{block.title}</Heading>}
                <p className={`whitespace-pre-wrap break-words border-l-4 pl-3 text-sm leading-relaxed ${TONE_EDGE[block.tone ?? "neutral"]} ${TONE_TEXT[block.tone ?? "neutral"]}`}>
                  {block.text}
                </p>
              </section>
            );
          case "list":
            return (
              <section key={i} className="flex flex-col gap-2">
                <Heading>{block.title}</Heading>
                <ul className="flex flex-col gap-2">
                  {block.items.map((item, j) => (
                    <li key={j} className={`flex flex-col gap-1 border-l-4 bg-cream/50 py-1.5 pl-3 pr-2 text-sm ${TONE_EDGE[item.tone ?? "neutral"]}`}>
                      {(item.badge || item.mono) && (
                        <span className="flex flex-wrap items-center gap-2">
                          {item.badge && (
                            <span className={`px-1.5 font-pixel text-[10px] uppercase tracking-wider ${item.badge === "blocker" ? TONE_PILL.bad : item.badge === "minor" ? TONE_PILL.wait : TONE_PILL[item.tone ?? "neutral"]}`}>
                              {item.badge}
                            </span>
                          )}
                          {item.mono && <span className="break-all font-mono text-xs text-ink-soft">{item.mono}</span>}
                        </span>
                      )}
                      <span className="whitespace-pre-wrap break-words">{item.text}</span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          case "chips":
            return (
              <section key={i} className="flex flex-col gap-2">
                <Heading>{block.title}</Heading>
                <ul className="flex flex-wrap gap-1.5">
                  {block.items.map((item) => (
                    <li key={item} className="break-all bg-cream-dark px-1.5 py-0.5 font-mono text-[11px]">{item}</li>
                  ))}
                </ul>
              </section>
            );
        }
      })}
    </>
  );
}
