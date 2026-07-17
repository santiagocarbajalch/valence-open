"use client";

import { useEffect, useRef, useState } from "react";
import { cx } from "./core";

// ── accessible action menu (a11y rebuild 2026-07-03) ─────────────────────────
// The rules every overlay follows, applied to menus:
//   · Escape closes and returns focus to the trigger
//   · clicking anywhere outside closes
//   · the panel is OPAQUE (solid bg-3) — a menu that offers destructive
//     actions never lets the text beneath bleed through
//   · ArrowUp/ArrowDown/Home/End move focus between items; Enter activates
// Items marked danger render in the bad tone; `separator` draws a rule above.

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  separator?: boolean;
}

export function Menu({ label, items, align = "right", direction = "down", children, className }: {
  label: string;               // accessible name for the trigger button
  items: MenuItem[];
  align?: "left" | "right";
  // "up" opens the panel ABOVE the trigger — for menus pinned near the bottom of
  // an overflow-clipped pane (the Today reply zone) where a downward panel clips.
  direction?: "up" | "down";
  children: React.ReactNode;   // trigger content
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const onPanelKey = (e: React.KeyboardEvent) => {
    const list = itemRefs.current.filter(Boolean) as HTMLButtonElement[];
    if (list.length === 0) return;
    const i = list.findIndex((el) => el === document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    else if (e.key === "Home") { e.preventDefault(); list[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); list[list.length - 1].focus(); }
    else if (e.key === "Tab") { setOpen(false); }
  };

  return (
    <div ref={rootRef} className={cx("relative", className)}>
      <button
        ref={btnRef}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="rounded-ctl border border-line-strong px-2.5 py-1 text-caption text-ink-dim transition-colors hover:bg-fill-2 hover:text-ink"
      >
        {children}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          onKeyDown={onPanelKey}
          className={cx(
            "absolute z-30 flex w-60 flex-col rounded-card border border-line-strong bg-bg-3 p-1.5 shadow-2xl",
            direction === "up" ? "bottom-full mb-1.5" : "top-full mt-1.5",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {items.map((it, i) => (
            <span key={it.label} className="flex flex-col">
              {it.separator && <span aria-hidden className="mx-2 my-1 border-t border-line" />}
              <button
                role="menuitem"
                ref={(el) => { itemRefs.current[i] = el; }}
                onClick={() => { close(true); it.onSelect(); }}
                className={cx(
                  "rounded-ctl px-3 py-2 text-left text-body",
                  it.danger ? "text-tone-bad-ink hover:bg-tone-bad/10" : "text-ink hover:bg-fill-2",
                )}
              >
                {it.label}
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
