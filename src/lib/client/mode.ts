"use client";
import { useEffect, useState } from "react";

/* * Simple mode (default) shows only what a beginner needs; full mode shows every tool. Stored per device. */
export type Mode = "simple" | "full";
const KEY = "margin-mode";
const EVENT = "margin-mode-change";

export function readMode(): Mode {
  try {
    return localStorage.getItem(KEY) === "full" ? "full" : "simple";
  } catch {
    return "simple";
  }
}

export function useMode(): [Mode, (m: Mode) => void] {
  const [mode, setMode] = useState<Mode>("simple");
  useEffect(() => {
    setMode(readMode());
    const on = () => setMode(readMode());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const set = (m: Mode) => {
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* storage unavailable: still switch for this page */
    }
    setMode(m);
    window.dispatchEvent(new Event(EVENT));
  };
  return [mode, set];
}
