"use client";

import { useCallback, useRef, useState } from "react";
import { VaultGraph3D } from "./VaultGraph3D";
import { FilesView, type FileTarget } from "./FilesView";

// ─────────────────────────────────────────────────────────────────────────────
// VAULT — the whole knowledge system on one page (operator ruling 2026-07-12,
// replaces the separate Files tab and the Workspace graph sub-tab):
//   section 1 (full viewport): the 3D map of every folder and file
//   section 2 (full viewport): the familiar three-pane file navigator
// One scroll, no sub-tabs. Clicking any node up top opens that folder or file
// down below and brings the navigator into view.
// ─────────────────────────────────────────────────────────────────────────────

const HEADER_H = 52; // the persistent console bar in page.tsx

export function VaultView() {
  const [target, setTarget] = useState<FileTarget | null>(null);
  const filesRef = useRef<HTMLElement>(null);

  const openFile = useCallback((root: string, path: string, isDir?: boolean) => {
    setTarget({ root, path, seq: Date.now(), isDir });
    filesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="thin-scroll h-full snap-y snap-proximity overflow-y-auto">
      {/* SECTION 1 — the 3D map. A hair short of the full viewport so the
          "browse the files" seam always peeks (the canvas eats scroll-wheel
          for zoom, so the way down must stay visible). */}
      <section
        aria-label="Vault map"
        className="snap-start px-5 pb-2 pt-3 sm:px-8"
        style={{ height: `calc(100vh - ${HEADER_H + 40}px)` }}
      >
        <VaultGraph3D onOpenFile={openFile} />
      </section>

      {/* the seam — tells the operator there's a second room down here */}
      <a
        href="#vault-files"
        onClick={(e) => { e.preventDefault(); filesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
        className="group mx-auto flex w-fit flex-col items-center gap-0.5 pb-1"
      >
        <span className="eyebrow group-hover:text-ink-dim">BROWSE THE FILES</span>
        <span className="animate-bounce text-ink-faint group-hover:text-ink-dim">▾</span>
      </a>

      {/* SECTION 2 — the file navigator, a full viewport */}
      <section
        id="vault-files"
        ref={filesRef}
        aria-label="Vault files"
        className="snap-start"
        style={{ height: `calc(100vh - ${HEADER_H}px)` }}
      >
        <FilesView target={target} />
      </section>
    </div>
  );
}
