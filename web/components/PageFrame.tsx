"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import ThemeToggle from "./ThemeToggle";

/** The header and page width: a run's page is wide (office beside the log), the others are narrower. */
export default function PageFrame({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const wide = path.startsWith("/runs/") && path !== "/runs/new";
  const width = wide ? "max-w-[110rem]" : "max-w-6xl";
  return (
    <>
      <a href="#main" className="skip-link">Skip to content</a>
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
        <div className="flex items-center gap-4">
          <span className="hidden font-pixel text-sm text-ink-soft md:block">a crew of four, fixing issues</span>
          <ThemeToggle />
        </div>
      </header>
      <main id="main" tabIndex={-1} className={`mx-auto ${width} px-4 pb-16 outline-none sm:px-6`}>{children}</main>
    </>
  );
}
