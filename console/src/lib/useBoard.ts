"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Board, Mtimes } from "@/components/cockpit/types";

// THE board feed — one fetch + optimistic-hide contract for every board
// surface (ONE DESK port, 2026-07-12; Today and Pipeline carried identical
// copies). The contract: a landed registry write hides its row immediately
// (`hide`), the next successfully REGENERATED view clears the whole hidden
// set — if the engine caught up the rows are gone anyway; if it errored they
// honestly reappear (tenet 11).
export function useBoard() {
  const [board, setBoard] = useState<Board | null>(null);
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // the mtimes the current board was built from — the new-mail watch compares
  // against these and may advance `drafts` on its own
  const mtimes = useRef<Mtimes | null>(null);

  const load = useCallback((opts?: { force?: boolean }) => {
    setLoading(true); setErr(false);
    fetch(`/api/board${opts?.force ? "?force=1" : ""}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((b: Board) => {
        setBoard(b);
        mtimes.current = b.mtimes;
        if (b.regenerated) setHidden(new Set());
      })
      .catch(() => setErr(true))
      .finally(() => setLoading(false));
  }, []);

  // a finished send reloads the board on its own (task tray fires this event;
  // operator ruling 2026-07-13: never make the operator click refresh after a
  // send — the server side already re-pulled the corpus and marked the board
  // dirty, so this load comes back regenerated)
  useEffect(() => {
    const onRefresh = () => load();
    window.addEventListener("velab:board-refresh", onRefresh);
    return () => window.removeEventListener("velab:board-refresh", onRefresh);
  }, [load]);

  const hide = useCallback((key: string) => setHidden((h) => new Set(h).add(key)), []);
  const hideAll = useCallback((keys: string[]) =>
    setHidden((h) => { const n = new Set(h); for (const k of keys) n.add(k); return n; }), []);

  return { board, setBoard, view: board?.view ?? null, err, loading, hidden, hide, hideAll, load, mtimes };
}
