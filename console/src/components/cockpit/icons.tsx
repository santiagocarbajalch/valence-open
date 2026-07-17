// Real SVG iconography for meaning-bearing marks (a11y rebuild 2026-07-03).
// Emoji rendered inconsistently across platforms and were announced
// unpredictably (or not at all) by screen readers. Every icon here is
// decorative by default (aria-hidden) — the ADJACENT TEXT carries the meaning.
// currentColor throughout, so tone comes from the parent's text color.

function Svg({ d, size = 14, filled }: { d: string; size?: number; filled?: boolean }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block shrink-0 align-[-2px]"
    >
      <path d={d} />
    </svg>
  );
}

export const IconGear = ({ size }: { size?: number }) => (
  <Svg size={size} d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.1l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-1.9-1.1L14.6 3h-4l-.4 2.6a7.5 7.5 0 0 0-1.9 1.1l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.2l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 1.9 1.1l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 1.9-1.1l2.4 1 2-3.4-2-1.6c.06-.36.1-.73.1-1.1Z" />
);

export const IconRefresh = ({ size }: { size?: number }) => (
  <Svg size={size} d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
);

export const IconNote = ({ size }: { size?: number }) => (
  <Svg size={size} d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
);

export const IconCalendar = ({ size }: { size?: number }) => (
  <Svg size={size} d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
);

export const IconChevron = ({ open }: { open: boolean }) => (
  <svg aria-hidden width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
    className="inline-block shrink-0 transition-transform"
    style={{ transform: open ? "rotate(90deg)" : "none" }}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const IconMore = ({ size = 16 }: { size?: number }) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className="inline-block shrink-0 align-[-3px]">
    <circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" />
  </svg>
);

export const IconMail = ({ size }: { size?: number }) => (
  <Svg size={size} d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm18 3-10 6L2 7" />
);
