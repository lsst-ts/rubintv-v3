// Standardised outline UI icons (feather-style stroke), ported from the design
// (design/from-claude/Camera Table - Sidebar v2.html). Sized via the .ui-icon
// class; colour follows currentColor so they inherit the button's text colour.

const base = {
  className: "ui-icon",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function CalendarIcon() {
  return (
    <svg {...base}>
      <rect x="3" y="4.5" width="18" height="16" rx="2" />
      <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
    </svg>
  );
}

export function ColumnsIcon() {
  return (
    <svg {...base}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </svg>
  );
}

export function DownloadIcon() {
  return (
    <svg {...base}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5M12 15V3" />
    </svg>
  );
}

export function ChevronDownIcon() {
  return (
    <svg {...base} className="ui-icon chevron" strokeWidth={2.2}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

// Seq nav — previous exposure (chevron pointing left).
export function ArrowLeftIcon() {
  return (
    <svg {...base}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

// Seq nav — next exposure (chevron pointing right).
export function ArrowRightIcon() {
  return (
    <svg {...base}>
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

// Jump to current — right arrow into a bar (media "seek to latest").
export function JumpToCurrentIcon() {
  return (
    <svg {...base}>
      <path d="M5 12h11M11 6l6 6-6 6M20 5v14" />
    </svg>
  );
}

// Image viewer — an external-link "open image" glyph.
export function ViewerIcon() {
  return (
    <svg {...base}>
      <path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
      <path d="M15 3h6v6M21 3l-9 9" />
    </svg>
  );
}

// Quicklook — a quick zoomed preview (magnifier).
export function QuicklookIcon() {
  return (
    <svg {...base}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3M11 8v6M8 11h6" />
    </svg>
  );
}

// Copy row — overlapping sheets (clipboard copy).
export function CopyIcon() {
  return (
    <svg {...base}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

// Foldout — a list/details glyph for metadata cells whose value is an object;
// clicking opens the full key/value set in a modal.
export function DetailsIcon() {
  return (
    <svg {...base}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}

// Check mark — the copy-confirmation state. pathLength=1 lets CSS animate the
// stroke "drawing" itself in.
export function CheckIcon() {
  return (
    <svg {...base}>
      <path d="M4 12.5l5 5 11-11" pathLength={1} />
    </svg>
  );
}
