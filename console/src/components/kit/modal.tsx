"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Action, cx } from "./core";
import { toneMix } from "./tokens";

// ── shared dialog chrome: Escape closes, Tab is trapped, focus restores ──
// Every overlay in the console (modal, drawer, menu) follows the same three
// rules; this hook is the one implementation modals and drawers share.
function useDialogChrome(ref: React.RefObject<HTMLDivElement | null>, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) { e.preventDefault(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && ref.current?.contains(active);
      if (e.shiftKey) {
        if (!inside || active === first) { e.preventDefault(); last.focus(); }
      } else if (!inside || active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    (focusables()[0] ?? ref.current)?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      restore?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// ── accessible modal shell (Escape / focus trap / restore / dirty guard) ──
export function Modal({ title, onClose, children, footer, wide, dirty }: {
  title: React.ReactNode; onClose: () => void; children: React.ReactNode;
  footer?: React.ReactNode; wide?: boolean; dirty?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const tryClose = () => {
    if (dirty && !window.confirm("Discard your changes?")) return;
    onClose();
  };
  useDialogChrome(ref, tryClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm" onClick={tryClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx(
          "glass-strong flex max-h-[84vh] flex-col rounded-modal bg-bg-3/95 p-5 shadow-2xl",
          wide ? "w-[640px]" : "w-[540px]",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 id={titleId} className="text-title font-medium text-ink">{title}</h3>
          <button aria-label="Close" onClick={tryClose} className="rounded text-ink-faint hover:text-ink">✕</button>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmModal({ title, body, reasonLabel, danger, confirmLabel, onConfirm, onClose }: {
  title: string; body?: React.ReactNode; reasonLabel?: string; danger?: boolean; confirmLabel: string;
  onConfirm: (reason: string) => void; onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const ok = !reasonLabel || reason.trim().length > 0;
  return (
    <Modal title={title} onClose={onClose} dirty={reason.trim().length > 0}
      footer={
        <>
          <Action variant="neutral" onClick={onClose}>Cancel</Action>
          <button disabled={!ok} onClick={() => onConfirm(reason.trim())}
            className={cx(
              "rounded-ctl px-4 py-1.5 text-caption font-medium disabled:opacity-40",
              danger ? "bg-tone-bad text-tone-bad-contrast" : "bg-accent text-accent-contrast",
            )}>
            {confirmLabel}
          </button>
        </>
      }>
      {body && <div className="mb-3 text-body text-ink-dim">{body}</div>}
      {reasonLabel && (
        <label className="block text-caption text-ink-dim">{reasonLabel}
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
            className="mt-1 w-full rounded-card border border-line bg-well px-3 py-2 text-body text-ink outline-none focus:border-line-strong" />
        </label>
      )}
    </Modal>
  );
}

/**
 * Right-side slide-over drawer (Drafts, System status). Same chrome contract
 * as Modal: Escape closes, Tab is trapped, focus returns to the opener,
 * clicking the scrim closes. Solid-backed so content never bleeds through.
 */
export function Drawer({ title, children, onClose }: {
  title: string; children: React.ReactNode; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogChrome(ref, onClose);
  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
      <aside
        ref={ref}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute bottom-0 right-0 top-0 flex w-[560px] max-w-full flex-col border-l border-line-strong bg-bg-2 p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-title font-medium text-ink">{title}</h2>
          <button aria-label="Close" onClick={onClose}
            className="rounded-ctl px-2 py-1 text-ink-dim hover:bg-fill-2 hover:text-ink">✕</button>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>
  );
}

/**
 * Full-screen detail overlay — the big accent-bordered dialog used for
 * agent dossiers and cron detail. Presentation shell only: caller renders
 * its own header content and body; Escape and scrim-click close it.
 */
export function Overlay({ onClose, accent, maxWidth = 940, children }: {
  onClose: () => void; accent?: string; maxWidth?: number; children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" />
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        className="glass-strong sheen relative flex h-[84vh] w-full flex-col overflow-hidden rounded-modal"
        style={{
          maxWidth,
          borderColor: accent ? `color-mix(in srgb, ${accent} 35%, var(--glass-edge-strong))` : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Underline tab strip for Overlay dialogs (agent card, cron detail). */
export function OverlayTabs<T extends string>({ tabs, active, onChange, accent }: {
  tabs: { id: T; label: string }[]; active: T; onChange: (id: T) => void; accent?: string;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-line px-5">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          aria-current={active === t.id ? "page" : undefined}
          className={cx("relative px-3.5 py-2.5 text-body transition-colors", active === t.id ? "text-ink" : "text-ink-dim hover:text-ink")}
        >
          {t.label}
          {active === t.id && (
            <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full"
              style={{ background: accent ?? "var(--accent)", boxShadow: `0 0 8px ${toneMix(accent ?? "var(--accent)", 60)}` }} />
          )}
        </button>
      ))}
    </div>
  );
}
