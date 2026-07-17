"use client";

import { useSyncExternalStore } from "react";
import { TONE, type Tone } from "./tokens";

// ── toast system (module store + <Toaster/>) — detached jobs report back ──
export interface Toast { id: number; msg: string; tone: Tone; action?: { label: string; run: () => void } }
let _toasts: Toast[] = [];
let _tid = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function toast(msg: string, opts: { tone?: Tone; action?: { label: string; run: () => void }; ttl?: number } = {}) {
  const id = ++_tid;
  _toasts = [..._toasts, { id, msg, tone: opts.tone ?? "info", action: opts.action }];
  emit();
  const ttl = opts.ttl ?? 6000;
  if (ttl) setTimeout(() => { _toasts = _toasts.filter((t) => t.id !== id); emit(); }, ttl);
  return id;
}
function dismiss(id: number) { _toasts = _toasts.filter((t) => t.id !== id); emit(); }

export function Toaster() {
  const toasts = useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb); },
    () => _toasts,
    () => _toasts,
  );
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id}
          className="glass-strong pointer-events-auto flex items-center gap-3 rounded-card px-3.5 py-2.5 text-body text-ink shadow-lg"
          style={{ borderLeft: `2px solid ${TONE[t.tone]}` }}>
          <span>{t.msg}</span>
          {t.action && (
            <button onClick={() => { t.action!.run(); dismiss(t.id); }} className="font-medium text-accent">
              {t.action.label}
            </button>
          )}
          <button aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-ink-faint hover:text-ink">✕</button>
        </div>
      ))}
    </div>
  );
}
