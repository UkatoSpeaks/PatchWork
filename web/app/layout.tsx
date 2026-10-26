import type { Metadata } from "next";
import { JetBrains_Mono, Pixelify_Sans } from "next/font/google";

import PageFrame from "@/components/PageFrame";

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
        <PageFrame>{children}</PageFrame>
      </body>
    </html>
  );
}
