"use client";

import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";

export const THEME_KEY = "patchwork:theme";
const ORDER: Theme[] = ["system", "light", "dark"];
const LOOK: Record<Theme, { icon: string; label: string }> = {
  system: { icon: "◐", label: "System theme" },
  light: { icon: "☀", label: "Light theme" },
  dark: { icon: "☾", label: "Dark theme" },
};

/** Runs before the page paints (inlined in <head>), so a saved theme never flashes. */
export const themeScript = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

function apply(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // no storage: the choice lasts for this page only
  }
}

/** Cycles system → light → dark. */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    setTheme(current === "light" || current === "dark" ? current : "system");
  }, []);
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
  return (
    <button
      type="button"
      className="pixel-btn inline-flex h-8 items-center gap-1.5 px-2 text-sm"
      onClick={() => {
        apply(next);
        setTheme(next);
      }}
      title={`${LOOK[theme].label} (click for ${LOOK[next].label.toLowerCase()})`}
      aria-label={`${LOOK[theme].label}. Switch to ${LOOK[next].label.toLowerCase()}`}
    >
      <span aria-hidden>{LOOK[theme].icon}</span>
      <span className="hidden font-pixel text-xs sm:inline">{theme}</span>
    </button>
  );
}
