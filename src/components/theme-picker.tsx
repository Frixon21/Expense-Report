"use client";
import { useEffect, useState } from "react";
type Theme = "light" | "dark" | "system";
export default function ThemePicker() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("biztech-theme");
      if (["light", "dark", "system"].includes(saved ?? ""))
        setTheme(saved as Theme);
    } catch {}
  }, []);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media?.matches ? "dark" : "light") : theme;
    };
    apply();
    media?.addEventListener("change", apply);
    return () => media?.removeEventListener("change", apply);
  }, [theme]);
  return (
    <label className="theme-picker">
      Theme
      <select
        aria-label="Theme"
        value={theme}
        onChange={(e) => {
          const value = e.target.value as Theme;
          setTheme(value);
          try {
            localStorage.setItem("biztech-theme", value);
          } catch {}
        }}
      >
        <option value="light">Light</option>
        <option value="dark">Dark</option>
        <option value="system">System</option>
      </select>
    </label>
  );
}
