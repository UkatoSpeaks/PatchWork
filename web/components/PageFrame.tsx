"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** The header and page width: a run's page is wide (office beside the log), the others are narrower. */
export default function PageFrame({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const wide = path.startsWith("/runs/") && path !== "/runs/new";
  const width = wide ? "max-w-[110rem]" : "max-w-6xl";
  return (
    <>
      <header className={`mx-auto flex ${width} items-center justify-between px-4 pt-6 pb-2 sm:px-6`}>
        <Link href="/" className="pixel-link flex items-center gap-3 font-pixel text-2xl font-bold tracking-wide">
          <span aria-hidden className="inline-grid h-7 w-7 grid-cols-2 grid-rows-2 gap-[2px] bg-ink p-[2px]">
            <span className="bg-terracotta" />
            <span className="bg-mustard" />
            <span className="bg-moss" />
            <span className="bg-slate" />
          </span>
          Patchwork Office
        </Link>
        <span className="hidden font-pixel text-sm text-ink-soft sm:block">a crew of four, fixing issues</span>
      </header>
      <main className={`mx-auto ${width} px-4 pb-16 sm:px-6`}>{children}</main>
    </>
  );
}
