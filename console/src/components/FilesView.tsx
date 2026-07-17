"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Action, Empty, ErrorState, PageHeader, Readout, Skeleton, cx, TONE, TONE_INK, toneMix } from "@/components/kit";
import { AGENTS, EXTRA_IDENTITY, DEFAULT_AGENT_COLOR } from "@/lib/agents";

// ─────────────────────────────────────────────────────────────────────────────
// FILES — a familiar three-pane vault navigator (drives → folder listing →
// preview/edit), over the curated roots /api/files exposes. Markdown renders
// through a small hand-rolled renderer (HTML-escaped first, no dependency);
// [[wikilinks]] and relative .md links navigate inside this view. Edits go
// through the guarded PUT (file must pre-exist, ≤2MB, JSON validated).
// Every drive/folder carries an "owned by <Agent>" badge — ownership comes
// from the canonical manifest vault/os/ownership.md via the API.
// ─────────────────────────────────────────────────────────────────────────────

interface Entry { name: string; relPath: string; size: number; mtime: number; isDir: boolean; fileCount?: number; children?: Entry[] }
interface RootTree { id: string; label: string; owner?: string | null; readOnly?: string | null; fileCount: number; truncated: boolean; entries: Entry[] }
interface FileData { root: string; path: string; content: string; mtime: number; size: number; ext: string }
export interface FileTarget { root: string; path: string; seq: number; isDir?: boolean }

// ---------- tiny markdown renderer (escape first, then structure) ----------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// inline spans — input is already HTML-escaped
function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // [[key]] / [[key|label]] wikilinks → in-view navigation (data-wiki)
    .replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_m, key: string, label?: string) =>
      `<a href="#" data-wiki="${key.trim()}">${label ?? key.trim()}</a>`)
    // [text](target) — local .md targets navigate in-view, real URLs open a tab.
    // Scheme allowlist: ONLY http(s)/mailto become real links. A bare "://" test
    // let "javascript://%0a…(payload)" through (esc() doesn't neutralize it) →
    // stored XSS from any vault .md built out of attacker-controlled email/scrape
    // content. Anything not on the allowlist and not a local .md renders as text.
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) =>
      /^https?:\/\//i.test(href) || /^mailto:/i.test(href)
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
        : href.toLowerCase().endsWith(".md")
          ? `<a href="#" data-rel="${href}">${text}</a>`
          : text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function mdToHtml(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) { out.push(`<p>${inline(esc(para.join(" ")))}</p>`); para = []; }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) { // fenced code
      flush();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); const l = h[1].length; out.push(`<h${l}>${inline(esc(h[2]))}</h${l}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); out.push("<hr/>"); i++; continue; }
    // table: a | row followed by a |---|---| separator
    if (line.trimStart().startsWith("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      flush();
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) { rows.push(splitRow(lines[i])); i++; }
      out.push(
        `<div class="md-scroll"><table><thead><tr>${head.map((c) => `<th>${inline(esc(c))}</th>`).join("")}</tr></thead>` +
        `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(esc(c))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
      );
      continue;
    }
    const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      flush();
      const ordered = /^\d/.test(li[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*]|\d+\.)\s+(.*)$/);
        if (!m) break;
        items.push(`<li>${inline(esc(m[2]))}</li>`);
        i++;
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
      out.push(`<blockquote>${inline(esc(buf.join(" ")))}</blockquote>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line);
    i++;
  }
  flush();
  return out.join("\n");
}

// YAML frontmatter (--- block) → key/value chips instead of raw YAML
function splitFrontmatter(src: string): { fm: [string, string][] | null; body: string } {
  if (!src.startsWith("---\n")) return { fm: null, body: src };
  const end = src.indexOf("\n---", 4);
  if (end < 0) return { fm: null, body: src };
  const nl = src.indexOf("\n", end + 1);
  const body = nl < 0 ? "" : src.slice(nl + 1);
  const fm: [string, string][] = [];
  for (const line of src.slice(4, end).split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) fm.push([m[1], m[2]]);
  }
  return { fm: fm.length ? fm : null, body };
}

// ---------- small formatting helpers ----------

// Frontmatter keys spoken plainly (V4.1 jargon sweep). Keys not listed here are
// machine detail — folded behind "More details", never headline chips.
const FM_LABELS: Record<string, string> = {
  key: "company",
  last_in: "last heard from them",
  last_out: "our last message",
  updated: "updated",
  as_of: "updated",
};
const fmDate = (v: string) => {
  const m = v.match(/^\d{4}-\d{2}-\d{2}/);
  if (!m) return v;
  const d = new Date(m[0] + "T12:00:00");
  return isNaN(d.getTime()) ? v : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

// Display name: hide the .md extension on human pages (title attr keeps truth)
const displayName = (name: string) => name.replace(/\.md$/i, "");

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtWhen(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const now = new Date();
  const hm = d.toTimeString().slice(0, 5);
  if (d.toDateString() === now.toDateString()) return `Today ${hm}`;
  const md = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.getFullYear() === now.getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}

function dirEntries(rt: RootTree, dir: string): Entry[] {
  if (!dir) return rt.entries;
  let cur = rt.entries;
  for (const seg of dir.split("/")) {
    const e = cur.find((x) => x.isDir && x.name === seg);
    if (!e) return [];
    cur = e.children ?? [];
  }
  return cur;
}

function allFiles(entries: Entry[], acc: Entry[] = []): Entry[] {
  for (const e of entries) {
    if (e.isDir) allFiles(e.children ?? [], acc);
    else acc.push(e);
  }
  return acc;
}

// ---------- ownership badges (facts come from vault/os/ownership.md) ----------

// identity color for a manifest agent name — visual metadata from lib/agents.ts
function agentColor(owner: string): string {
  const id = owner.toLowerCase();
  return AGENTS.find((a) => a.id === id)?.color ?? EXTRA_IDENTITY[id]?.color ?? DEFAULT_AGENT_COLOR;
}

/** "owned by <Agent>" pill — identity-colored dot + plain-language name. */
function OwnerBadge({ owner, prefix, className }: { owner?: string | null; prefix?: boolean; className?: string }) {
  if (!owner) return null;
  const c = agentColor(owner);
  return (
    <span
      title={`This area is looked after by ${owner}`}
      className={cx(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-1.5 py-[1px] text-micro text-ink-dim",
        className,
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: c, boxShadow: `0 0 5px ${c}` }} />
      {prefix ? `owned by ${owner}` : owner}
    </span>
  );
}

// ---------- sidebar tree (roots as drives, folders collapsible) ----------

function DirRow({ rootId, entry, depth, owner, openKeys, sel, onSelect }: {
  rootId: string; entry: Entry; depth: number; owner?: string | null; openKeys: Set<string>;
  sel: { root: string; dir: string }; onSelect: (root: string, dir: string) => void;
}) {
  const key = `${rootId}:${entry.relPath}`;
  const open = openKeys.has(key);
  const dirs = (entry.children ?? []).filter((e) => e.isDir);
  const active = sel.root === rootId && sel.dir === entry.relPath;
  return (
    <>
      <button
        onClick={() => onSelect(rootId, entry.relPath)}
        title={owner ? `${entry.name} — owned by ${owner}` : entry.name}
        className={cx(
          "flex w-full items-center gap-1.5 rounded-ctl py-1 pr-2 text-left text-caption transition-colors",
          active ? "bg-fill-3 text-ink" : "text-ink-dim hover:bg-fill-2 hover:text-ink",
        )}
        style={{ paddingLeft: 10 + depth * 13 }}
      >
        <span aria-hidden className="w-3 shrink-0 text-ink-faint">{dirs.length ? (open ? "▾" : "▸") : "·"}</span>
        <span className="min-w-0 flex-1 truncate">{displayName(entry.name || entry.relPath.split("/").pop() || entry.relPath)}</span>
        {owner && (
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full opacity-70" style={{ background: agentColor(owner) }} />
        )}
        <Readout className="shrink-0 text-micro text-ink-dim">{entry.fileCount ?? 0}</Readout>
      </button>
      {open && dirs.map((d) => (
        <DirRow key={d.relPath} rootId={rootId} entry={d} depth={depth + 1} owner={owner} openKeys={openKeys} sel={sel} onSelect={onSelect} />
      ))}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function FilesView({ target }: { target?: FileTarget | null }) {
  const [roots, setRoots] = useState<RootTree[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [sel, setSel] = useState<{ root: string; dir: string }>({ root: "companies", dir: "" });
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set(["root:companies"]));
  const [query, setQuery] = useState("");
  const [file, setFile] = useState<{ root: string; path: string } | null>(null);
  const [data, setData] = useState<FileData | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const loadTrees = useCallback(() => {
    setLoadErr(false);
    fetch("/api/files?op=tree")
      .then((r) => r.json())
      .then((d) => setRoots(d.roots ?? []))
      .catch(() => setLoadErr(true));
  }, []);
  useEffect(loadTrees, [loadTrees]);

  const openFile = useCallback((rootId: string, relPath: string) => {
    const dir = relPath.split("/").slice(0, -1).join("/");
    setSel({ root: rootId, dir });
    setOpenKeys((prev) => {
      const next = new Set(prev);
      next.add(`root:${rootId}`);
      const segs = dir ? dir.split("/") : [];
      for (let i = 1; i <= segs.length; i++) next.add(`${rootId}:${segs.slice(0, i).join("/")}`);
      return next;
    });
    setQuery("");
    setFile({ root: rootId, path: relPath });
    setEditing(false);
    setSaveMsg(null);
    setFileErr(null);
    setFileLoading(true);
    fetch(`/api/files?op=read&root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(relPath)}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "couldn't open it");
        setData(d as FileData);
        previewRef.current?.scrollTo({ top: 0 });
      })
      .catch((e: Error) => { setData(null); setFileErr(e.message); })
      .finally(() => setFileLoading(false));
  }, []);

  // the graph (or any other tab) can ask us to open a specific file — or, for
  // a map cluster, to navigate to a FOLDER (expand its branch, list it)
  useEffect(() => {
    if (!target) return;
    if (target.isDir) {
      const dir = target.path.replace(/\/+$/, "");
      setSel({ root: target.root, dir });
      setOpenKeys((prev) => {
        const next = new Set(prev);
        next.add(`root:${target.root}`);
        const segs = dir ? dir.split("/") : [];
        for (let i = 1; i <= segs.length; i++) next.add(`${target.root}:${segs.slice(0, i).join("/")}`);
        return next;
      });
      setQuery("");
    } else {
      openFile(target.root, target.path);
    }
  }, [target, openFile]);

  // folder selection: choose + toggle open (Finder-sidebar behavior)
  const selectDir = useCallback((rootId: string, dir: string) => {
    setSel({ root: rootId, dir });
    setQuery("");
    const key = dir ? `${rootId}:${dir}` : `root:${rootId}`;
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key) && sel.root === rootId && sel.dir === dir) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [sel]);

  // total files across every drive — a mono readout in the page header. Summed
  // from the tree the navigator already loaded; no extra fetch.
  const totalFiles = useMemo(() => (roots ?? []).reduce((n, r) => n + (r.fileCount ?? 0), 0), [roots]);
  const curRoot = useMemo(() => roots?.find((r) => r.id === sel.root) ?? null, [roots, sel.root]);
  const listing = useMemo(() => {
    if (!curRoot) return [];
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      return allFiles(curRoot.entries).filter((f) => f.name.toLowerCase().includes(q)).slice(0, 200);
    }
    return dirEntries(curRoot, sel.dir);
  }, [curRoot, sel.dir, query]);

  const crumbs = useMemo(() => {
    const segs = sel.dir ? sel.dir.split("/") : [];
    return [{ label: curRoot?.label ?? sel.root, dir: "" }, ...segs.map((s, i) => ({ label: s, dir: segs.slice(0, i + 1).join("/") }))];
  }, [curRoot, sel]);

  // rendered markdown (frontmatter split off into chips)
  const md = useMemo(() => {
    if (!data || data.ext !== "md") return null;
    const { fm, body } = splitFrontmatter(data.content);
    return { fm, html: mdToHtml(body) };
  }, [data]);

  const prettyJson = useMemo(() => {
    if (!data || data.ext !== "json") return null;
    try { return JSON.stringify(JSON.parse(data.content), null, 2); } catch { return data.content; }
  }, [data]);

  const regenerated = !!data && data.content.includes("do not hand-edit");
  // machine-written surfaces: the server refuses PUTs here, so don't offer the pencil
  const readOnly: string | null =
    curRoot?.readOnly
    ?? (file && sel.root === "companies" && (file.path === "INDEX.md" || file.path.endsWith("/INDEX.md"))
      ? "the truth engine rewrites INDEX.md on every board refresh"
      : null);

  // wikilink / relative-md-link navigation inside rendered markdown
  const onMdClick = useCallback((e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const wiki = a.getAttribute("data-wiki");
    const rel = a.getAttribute("data-rel");
    if (wiki) {
      e.preventDefault();
      openFile("companies", wiki.toLowerCase().endsWith(".md") ? wiki : `${wiki}.md`);
    } else if (rel && file) {
      e.preventDefault();
      const base = file.path.split("/").slice(0, -1).join("/");
      const clean = decodeURIComponent(rel).replace(/^\.\//, "");
      openFile(file.root, base ? `${base}/${clean}` : clean);
    }
  }, [openFile, file]);

  const save = useCallback(async () => {
    if (!file) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const r = await fetch("/api/files", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: file.root, path: file.path, content: draft }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "save failed");
      setData((prev) => (prev ? { ...prev, content: draft, mtime: d.mtime, size: draft.length } : prev));
      setEditing(false);
      setSaveMsg({ text: "Saved." });
    } catch (e) {
      setSaveMsg({ text: `Couldn't save — ${(e as Error).message}`, bad: true });
    } finally {
      setSaving(false);
    }
  }, [file, draft]);

  if (loadErr) return <div className="p-6"><ErrorState what="the vault file list" onRetry={loadTrees} /></div>;

  return (
    <div className="flex h-full flex-col px-5 pb-4 pt-3 sm:px-8">
      <PageHeader
        title="Files"
        eyebrow="THE VAULT — COMPANY PAGES, MEETINGS, PACKS & RECORDS"
        right={
          <>
            {roots && (
              <span className="text-caption text-ink-dim">
                <Readout className="text-ink">{totalFiles.toLocaleString("en-US")}</Readout> files
              </span>
            )}
            <Action onClick={loadTrees} title="Re-read the folder list">⟳ Refresh</Action>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 gap-3">
        {/* LEFT — drives & folders */}
        <nav aria-label="Vault folders" className="glass thin-scroll w-72 shrink-0 overflow-y-auto rounded-pane p-2">
          {!roots && <Skeleton rows={5} />}
          {roots?.map((rt) => {
            const open = openKeys.has(`root:${rt.id}`);
            const active = sel.root === rt.id && sel.dir === "";
            const dirs = rt.entries.filter((e) => e.isDir);
            return (
              <div key={rt.id} className="mb-0.5">
                <button
                  onClick={() => selectDir(rt.id, "")}
                  className={cx(
                    "flex w-full items-center gap-1.5 rounded-ctl px-2 py-1.5 text-left text-body transition-colors",
                    active ? "bg-fill-3 text-ink" : "text-ink-dim hover:bg-fill-2 hover:text-ink",
                  )}
                >
                  <span aria-hidden className="w-3 shrink-0 text-ink-faint">{dirs.length ? (open ? "▾" : "▸") : "◇"}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{rt.label}</span>
                  <OwnerBadge owner={rt.owner} />
                  <Readout className="shrink-0 text-micro text-ink-dim">{rt.fileCount}</Readout>
                </button>
                {open && dirs.map((d) => (
                  <DirRow key={d.relPath} rootId={rt.id} entry={d} depth={1} owner={rt.owner} openKeys={openKeys} sel={sel} onSelect={selectDir} />
                ))}
              </div>
            );
          })}
        </nav>

        {/* MIDDLE — folder listing */}
        <section className="glass flex min-w-0 flex-1 flex-col rounded-pane">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            {/* breadcrumb */}
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-caption">
              {crumbs.map((c, i) => (
                <span key={c.dir} className="flex min-w-0 items-center gap-1">
                  {i > 0 && <span aria-hidden className="text-ink-faint">/</span>}
                  <button
                    onClick={() => { setSel({ root: sel.root, dir: c.dir }); setQuery(""); }}
                    className={cx("truncate rounded-ctl px-1 py-0.5 transition-colors hover:bg-fill-2",
                      i === crumbs.length - 1 ? "text-ink" : "text-ink-dim hover:text-ink")}
                  >
                    {c.label}
                  </button>
                </span>
              ))}
            </div>
            <OwnerBadge owner={curRoot?.owner} prefix />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${curRoot?.label.toLowerCase() ?? "this drive"}…`}
              aria-label="Search files by name"
              className="w-44 rounded-ctl border border-line-strong bg-bg-2 px-2.5 py-1 text-caption text-ink placeholder:text-ink-dim"
            />
          </div>
          {curRoot?.truncated && (
            <p className="border-b border-line px-3 py-1.5 text-micro text-tone-warn-ink">
              This drive has more files than the console shows (first 500 listed).
            </p>
          )}
          <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
            {/* column headers */}
            <div className="flex items-center gap-3 px-2.5 pb-1 pt-0.5">
              <span className="eyebrow min-w-0 flex-1">Name</span>
              <span className="eyebrow w-24 text-right">Modified</span>
              <span className="eyebrow w-16 text-right">Size</span>
            </div>
            {listing.length === 0 && (
              <p className="px-3 py-6 text-center text-caption text-ink-dim">
                {query ? "Nothing here matches that name." : "This folder is empty."}
              </p>
            )}
            {listing.map((e) => {
              const isSel = !!file && file.root === sel.root && file.path === e.relPath;
              return (
                <button
                  key={e.relPath}
                  onClick={() => (e.isDir ? selectDir(sel.root, e.relPath) : openFile(sel.root, e.relPath))}
                  className={cx(
                    "flex w-full items-center gap-3 rounded-ctl px-2.5 py-1.5 text-left transition-colors",
                    isSel ? "bg-fill-3" : "hover:bg-fill-2",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span title={e.name} className={cx("block truncate text-body", e.isDir ? "font-medium text-ink" : "text-ink")}>
                      {e.isDir ? "▸ " : ""}{displayName(e.name || e.relPath.split("/").pop() || e.relPath)}
                    </span>
                    {query && <span className="block truncate text-micro text-ink-dim">{e.relPath}</span>}
                  </span>
                  {e.isDir && <OwnerBadge owner={curRoot?.owner} />}
                  <Readout className="w-24 shrink-0 text-right text-caption text-ink-dim">{e.isDir ? "—" : fmtWhen(e.mtime)}</Readout>
                  <Readout className="w-16 shrink-0 text-right text-caption text-ink-dim">
                    {e.isDir ? `${e.fileCount ?? 0} file${(e.fileCount ?? 0) === 1 ? "" : "s"}` : fmtSize(e.size)}
                  </Readout>
                </button>
              );
            })}
          </div>
        </section>

        {/* RIGHT — preview / edit */}
        <section className="glass flex min-w-0 flex-[1.4] flex-col rounded-pane">
          {!file && (
            <div className="grid flex-1 place-items-center p-6">
              <Empty>Pick a file on the left to read it here.</Empty>
            </div>
          )}
          {file && (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <h3 title={file.path.split("/").pop()} className="truncate text-body font-medium text-ink">{displayName(file.path.split("/").pop() ?? "")}</h3>
                  {data && (
                    <p className="truncate text-micro text-ink-dim">
                      Updated {fmtWhen(data.mtime)} · {fmtSize(data.size)} · {curRoot?.label ?? file.root}{file.path.includes("/") ? ` / ${file.path.split("/").slice(0, -1).join(" / ")}` : ""}{curRoot?.owner ? ` · owned by ${curRoot.owner}` : ""}
                    </p>
                  )}
                </div>
                {saveMsg && (
                  <span className="text-caption" style={{ color: saveMsg.bad ? TONE_INK.bad : TONE_INK.ok }}>{saveMsg.text}</span>
                )}
                {data && !editing && !readOnly && (
                  <Action onClick={() => { setDraft(data.content); setEditing(true); setSaveMsg(null); }}>✎ Edit</Action>
                )}
                {data && !editing && readOnly && (
                  <span className="text-caption text-ink-dim" title={readOnly}>Read-only — {readOnly}</span>
                )}
                {editing && (
                  <>
                    <Action variant="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Action>
                    <Action onClick={() => { setEditing(false); setSaveMsg(null); }} disabled={saving}>Cancel</Action>
                  </>
                )}
              </div>

              {regenerated && (
                <div
                  className="mx-4 mt-3 rounded-card border px-3 py-2 text-caption"
                  style={{ borderColor: toneMix(TONE.warn, 40), color: TONE_INK.warn, background: toneMix(TONE.warn, 8) }}
                >
                  This page is regenerated automatically — edits above the &ldquo;Operator notes&rdquo; section will be
                  overwritten on the next refresh. Your notes under &ldquo;Operator notes&rdquo; are kept.
                </div>
              )}

              <div ref={previewRef} className="thin-scroll min-h-0 flex-1 overflow-y-auto p-4">
                {fileLoading && <Skeleton rows={4} />}
                {fileErr && <p className="text-body text-tone-bad-ink">{fileErr}</p>}
                {data && editing && (
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    aria-label="File content"
                    spellCheck={false}
                    className="h-full min-h-[300px] w-full resize-none rounded-card border border-line-strong bg-well p-3 font-mono text-caption leading-relaxed text-ink"
                  />
                )}
                {data && !editing && (
                  <>
                    {md?.fm && (
                      <div className="mb-3">
                        <div className="flex flex-wrap gap-1.5">
                          {md.fm.filter(([k]) => FM_LABELS[k]).map(([k, v]) => (
                            <span key={k} title={`${k}: ${v}`}
                              className="max-w-full truncate rounded-full border border-line bg-fill-1 px-2 py-0.5 text-micro text-ink-dim">
                              <span className="text-ink-faint">{FM_LABELS[k]}:</span> {/last|updated|as_of/.test(k) ? fmDate(v) : v}
                            </span>
                          ))}
                        </div>
                        {md.fm.some(([k]) => !FM_LABELS[k]) && (
                          <details className="mt-1.5">
                            <summary className="cursor-pointer text-micro text-ink-dim hover:text-ink">More details</summary>
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {md.fm.filter(([k]) => !FM_LABELS[k]).map(([k, v]) => (
                                <span key={k} title={`${k}: ${v}`}
                                  className="max-w-full truncate rounded-full border border-line bg-fill-1 px-2 py-0.5 text-micro text-ink-dim">
                                  {k}: {v}
                                </span>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    )}
                    {md && (
                      <div className="md-body" onClick={onMdClick} dangerouslySetInnerHTML={{ __html: md.html }} />
                    )}
                    {data.ext === "json" && (
                      <pre className="overflow-x-auto rounded-card bg-well p-3 font-mono text-caption leading-relaxed text-ink-dim">{prettyJson}</pre>
                    )}
                    {(data.ext === "txt" || data.ext === "jsonl" || data.ext === "csv") && (
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded-card bg-well p-3 font-mono text-caption leading-relaxed text-ink-dim">{data.content}</pre>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
