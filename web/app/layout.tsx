import type { Metadata } from "next";
import { JetBrains_Mono, Pixelify_Sans } from "next/font/google";
import Link from "next/link";

import "./globals.css";

const pixel = Pixelify_Sans({ subsets: ["latin"], variable: "--font-pixelify", weight: ["400", "500", "600", "700"] });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: "Patchwork Office",
  description: "Replay Patchwork runs as a tiny pixel-art office.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${pixel.variable} ${mono.variable}`}>
      <body className="min-h-screen antialiased">
        <header className="mx-auto flex max-w-6xl items-center justify-between px-4 pt-6 pb-2 sm:px-6">
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
        <main className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
