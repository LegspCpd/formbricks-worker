"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * A slim top-of-viewport progress bar that appears the moment an in-app navigation starts and eases
 * to completion once the destination route commits.
 *
 * Next.js App Router gives no built-in "navigation started" event for plain <Link> clicks, so the
 * start is inferred from same-origin link clicks / back-forward navigation, and the finish from a
 * change in `usePathname()`. A safety timeout guarantees the bar can never hang if a navigation is
 * cancelled or the route renders without a path change. The bar is decorative (`aria-hidden`).
 */
const SAFETY_TIMEOUT_MS = 8000;

export const NavigationProgress = () => {
  const pathname = usePathname();
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const [progress, setProgress] = useState(0);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safetyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);

  const clearTimers = () => {
    if (tickTimer.current) {
      clearInterval(tickTimer.current);
      tickTimer.current = null;
    }
    if (doneTimer.current) {
      clearTimeout(doneTimer.current);
      doneTimer.current = null;
    }
    if (safetyTimer.current) {
      clearTimeout(safetyTimer.current);
      safetyTimer.current = null;
    }
  };

  const start = () => {
    if (activeRef.current) return;
    activeRef.current = true;
    clearTimers();
    setState("loading");
    setProgress(8);
    tickTimer.current = setInterval(() => {
      // Ease toward 90% and never reach it until the route actually commits.
      setProgress((prev) => (prev >= 90 ? prev : prev + (90 - prev) * 0.12 + 0.5));
    }, 160);
    safetyTimer.current = setTimeout(() => finish(), SAFETY_TIMEOUT_MS);
  };

  const finish = () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    clearTimers();
    setProgress(100);
    setState("done");
    doneTimer.current = setTimeout(() => {
      setState("idle");
      setProgress(0);
    }, 320);
  };

  // Finish whenever the committed route changes.
  useEffect(() => {
    finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    const isInternalAnchor = (event: MouseEvent) => {
      if (event.defaultPrevented) return false;
      // Only plain left-clicks without modifiers.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return false;

      const target = event.target as Element | null;
      const anchor = target?.closest?.("a");
      if (!anchor) return false;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return false;
      if (anchor.getAttribute("target") && anchor.getAttribute("target") !== "_self") return false;
      if (anchor.hasAttribute("download")) return false;

      // Same-origin only; external links do a full page load and must not show the bar.
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return false;
      }
      if (url.origin !== window.location.origin) return false;

      // Navigating to the exact current URL does not trigger a transition.
      const current = window.location.pathname + window.location.search;
      const next = url.pathname + url.search;
      if (next === current) return false;

      return true;
    };

    const onClick = (event: MouseEvent) => {
      if (isInternalAnchor(event)) {
        start();
      }
    };

    const onPopState = () => start();

    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPopState);

    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
      clearTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none fixed inset-x-0 top-0 z-[9999] h-0.5 transition-opacity duration-200 motion-reduce:hidden",
        state === "idle" ? "opacity-0" : "opacity-100"
      )}>
      <div
        className="h-full bg-brand-dark shadow-[0_0_8px_var(--color-brand-dark)] transition-[width] duration-200 ease-out"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
};
