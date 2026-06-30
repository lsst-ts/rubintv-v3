import { memo, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link } from "react-router-dom";
import type { DatePayload, Metadata } from "../lib/types";
import {
  isSortableKey,
  sortColForKey,
  type SortState,
} from "../lib/sort";
import { useAngledHeaders } from "../lib/useAngledHeaders";
import { fillTemplate } from "../lib/links";
import { CopyButton } from "../components/CopyButton";
import { CellModal } from "../components/CellModal";
import { ViewerIcon, QuicklookIcon, DetailsIcon } from "../components/Icons";

export type Density = "compact" | "regular";
const ROW_PAD: Record<Density, string> = {
  compact: "3px 8px",
  regular: "6px 8px",
};

export interface Column {
  key: string;
  label: string;
}

// The active sort direction for a column model key, or null when it isn't the
// sorted column. Used to render the ▲/▼ indicator and aria-sort on the header.
function sortDirFor(key: string, sort: SortState | null): "asc" | "desc" | null {
  if (!sort) return null;
  return sortColForKey(key) === sort.col ? sort.dir : null;
}

// Fixed per-column width (the table is table-layout:fixed). Channel columns are
// just one image chip + padding; without an explicit width they stretch to
// absorb leftover space. Action columns size to their link text; metadata
// columns get a compact default (values are short — angled labels float above
// in an overlay, so the column needn't fit the label).
function widthFor(key: string, density: Density): string {
  if (key === "seq") return "64px";
  if (key.startsWith("ch:")) return "44px"; // one chip + padding
  if (key === "viewer" || key === "quicklook" || key === "copy") return "34px";
  // Metadata columns: values are short, so compact trims the padded default
  // width that regular keeps for breathing room.
  return density === "compact" ? "64px" : "92px";
}

// A "_<col>" metadata value names CSS class(es) for the "<col>" cell — the old
// app's per-cell colour-indicator convention. We namespace each token under
// `cell-` to isolate it from app styles, and sanitise to a safe class token.
// Multiple space-separated tokens are honoured. Returns "" when absent/empty.
function cellFlagClass(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).trim();
  if (!s) return "";
  return s
    .split(/\s+/)
    .map((t) => "cell-" + t.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"))
    .join(" ");
}

// Truncate float-like metadata to 2dp for display, keeping the full value for a
// hover tooltip. Non-numeric values pass through.
function formatCell(value: unknown): { display: string; title?: string } {
  if (value === null || value === undefined || value === "")
    return { display: "—" };
  const s = String(value);
  if (typeof value === "number" || /^-?\d*\.\d+$/.test(s)) {
    const n = Number(value);
    if (!Number.isNaN(n)) {
      const trunc = (Math.trunc(n * 100) / 100).toFixed(2);
      return trunc === s ? { display: s } : { display: trunc, title: s };
    }
  }
  return { display: s };
}

// Some metadata values are JSON objects/arrays rather than scalars (e.g. a
// {DISPLAY_VALUE, ...details} record). These can't be shown inline; the cell
// renders a foldout button that opens a modal of the full key/value set. The
// button label is the object's DISPLAY_VALUE when present (returned as a
// string), else null — the caller renders a neutral details icon.
function foldoutLabel(data: Record<string, unknown> | unknown[]): string | null {
  if (!Array.isArray(data) && typeof data.DISPLAY_VALUE === "string") {
    return data.DISPLAY_VALUE;
  }
  return null;
}

// One table row. Extracted and memoized so that, with virtualization, only the
// ~30 on-screen rows exist in the DOM and a column change re-renders just those
// (not all 1000+). The cell logic is unchanged from the inline version.
interface RowProps {
  seq: number;
  rowIdx: number;
  columns: Column[];
  meta: Record<string, unknown>;
  payload: DatePayload | undefined;
  channelColour: Record<string, string>;
  location: string;
  camera: string;
  date: string;
  viewerTmpl: string | null;
  quicklookTmpl: string | null;
  copyRowTmpl: string | null;
  linkCtx: Props["linkCtx"];
  onFoldout: (modal: {
    header: string;
    data: Record<string, unknown> | unknown[];
  }) => void;
  // react-virtual measurement: ref + data-index let the virtualizer read each
  // row's true height (the chip cell makes a static estimate unreliable).
  measureRef: (el: HTMLTableRowElement | null) => void;
  dataIndex: number;
}

const Row = memo(function Row({
  seq,
  rowIdx,
  columns,
  meta,
  payload,
  channelColour,
  location,
  camera,
  date,
  viewerTmpl,
  quicklookTmpl,
  copyRowTmpl,
  linkCtx,
  onFoldout,
  measureRef,
  dataIndex,
}: RowProps) {
  return (
    <tr
      ref={measureRef}
      data-index={dataIndex}
      className={rowIdx === 0 ? "newest" : undefined}
    >
      {columns.map((c) => {
        if (c.key === "seq") {
          return (
            <td key="seq" className="seq">
              {seq}
            </td>
          );
        }
        if (c.key.startsWith("ch:")) {
          const chan = c.key.slice(3);
          const present = (payload?.channels[chan] ?? []).includes(seq);
          return (
            <td key={c.key}>
              {present ? (
                <Link
                  className="cell-chip"
                  style={{ background: channelColour[chan] }}
                  to={`/${location}/${camera}/${chan}?seq=${seq}&date=${date}`}
                  aria-label={`${chan} ${seq}`}
                />
              ) : (
                <span className="cell-chip empty" />
              )}
            </td>
          );
        }
        if (c.key === "viewer") {
          return (
            <td key="viewer" className="action-cell">
              <a
                className="action-link"
                href={fillTemplate(
                  viewerTmpl!,
                  date,
                  seq,
                  linkCtx(meta.controller),
                )}
                target="_blank"
                rel="noreferrer"
                aria-label="Viewer"
                title="Open in image viewer"
              >
                <ViewerIcon />
              </a>
            </td>
          );
        }
        if (c.key === "quicklook") {
          return (
            <td key="quicklook" className="action-cell">
              <a
                className="action-link"
                href={fillTemplate(
                  quicklookTmpl!,
                  date,
                  seq,
                  linkCtx(meta.controller),
                )}
                target="_blank"
                rel="noreferrer"
                aria-label="Quicklook"
                title="Open in Quicklook"
              >
                <QuicklookIcon />
              </a>
            </td>
          );
        }
        if (c.key === "copy") {
          return (
            <td key="copy" className="action-cell">
              <CopyButton
                icon
                text={fillTemplate(
                  copyRowTmpl!,
                  date,
                  seq,
                  linkCtx(meta.controller),
                )}
              />
            </td>
          );
        }
        // Metadata cell. A sibling "_<col>" key, when present, names a colour
        // class for this cell (the old app's per-cell indicator convention);
        // namespaced under cell- to isolate it.
        const col = c.key.slice(5);
        const value = meta[col];
        const flag = cellFlagClass(meta[`_${col}`]);
        // Object/array values can't render inline: show a foldout button that
        // opens the full key/value set in a modal.
        if (value !== null && typeof value === "object") {
          const data = value as Record<string, unknown> | unknown[];
          const label = foldoutLabel(data);
          return (
            <td key={c.key} className={flag}>
              <button
                type="button"
                className={label ? "button-table" : "action-link"}
                onClick={() =>
                  onFoldout({
                    header: `Seq Num: ${seq} - ${col}`,
                    data,
                  })
                }
                aria-label={label ?? `${col} details`}
                title={label ? undefined : "View details"}
              >
                {label ?? <DetailsIcon />}
              </button>
            </td>
          );
        }
        const { display, title } = formatCell(value);
        return (
          <td
            key={c.key}
            className={flag}
            title={title}
            style={{
              color: flag
                ? undefined
                : display === "—"
                  ? "var(--ink-soft)"
                  : "var(--ink)",
              cursor: title ? "help" : undefined,
            }}
          >
            {display}
          </td>
        );
      })}
    </tr>
  );
});

interface Props {
  columns: Column[];
  seqNums: number[];
  metadata: Metadata;
  payload: DatePayload | undefined;
  channelColour: Record<string, string>;
  sort: SortState | null;
  onSort: (key: string) => void;
  density: Density;
  location: string;
  camera: string;
  date: string;
  viewerTmpl: string | null;
  quicklookTmpl: string | null;
  copyRowTmpl: string | null;
  linkCtx: (controller?: unknown) => {
    siteLocation: string;
    controller: string | undefined;
    isDevInstance: boolean;
  };
}

// The camera data table: sticky Seq.No column, channel chips, per-row action
// columns, metadata cells, angled headers (measured overlay), newest-row
// highlight, density. Memoized so toolbar-only state on the parent (e.g.
// opening the column picker) doesn't re-render this large body — only changes
// to the table's own props do.
function CameraDataTableInner({
  columns,
  seqNums,
  metadata,
  payload,
  channelColour,
  sort,
  onSort,
  density,
  location,
  camera,
  date,
  viewerTmpl,
  quicklookTmpl,
  copyRowTmpl,
  linkCtx,
}: Props) {
  // Angled header labels are drawn in a measured overlay layer. Owning the hook
  // here keeps the reflow scoped to this component's own re-renders.
  const { wrapRef, headRef, positions, tableWidth } = useAngledHeaders(true, [
    columns,
    density,
  ]);

  // The currently open object-cell modal (foldout), or null when none. Holds
  // the dialog header and the object/array to display.
  const [modal, setModal] = useState<{
    header: string;
    data: Record<string, unknown> | unknown[];
  } | null>(null);

  // Row virtualization: with 1000+ rows, materializing every <tr> makes layout
  // (and any column change) costly. We render only the rows in view plus an
  // overscan margin, and pad the body with two spacer rows so the scrollbar and
  // sticky header still behave as if the full table were present. The scroll
  // element is the same `.table-wrap` the angled-header overlay measures; the
  // header isn't virtualized, so that overlay is unaffected. Rows are measured
  // dynamically (the fixed-height chip cell makes a static estimate unreliable).
  const bodyRef = useRef<HTMLTableSectionElement | null>(null);

  // Whether the table is scrolled to (or near) the very top. Drives anchorTo:
  // at the top we want new exposures to scroll into view like a live feed; once
  // the user has scrolled down to read older rows we pin the view instead so
  // prepended rows don't displace it. A few px of slack absorbs sub-pixel
  // scroll positions and momentum settling.
  const [atTop, setAtTop] = useState(true);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onScroll = () => setAtTop(wrap.scrollTop <= 4);
    onScroll(); // sync initial state (e.g. after a remount with a saved scroll)
    wrap.addEventListener("scroll", onScroll, { passive: true });
    return () => wrap.removeEventListener("scroll", onScroll);
  }, [wrapRef]);

  const rowVirtualizer = useVirtualizer({
    count: seqNums.length,
    getScrollElement: () => wrapRef.current,
    estimateSize: () => (density === "compact" ? 33 : 39),
    overscan: 12,
    // Key rows by their seq number, not the default list index. The table is
    // newest-first, so a live exposure prepends a row and shifts every index
    // down by one; a stable per-exposure key lets the virtualizer (and React)
    // track each row across that shift.
    getItemKey: (i) => seqNums[i],
    // Scroll anchoring for live updates. With newest-first ordering, new
    // exposures prepend and push every row down — a user scrolled into older
    // rows would otherwise have their view bumped on each update. anchorTo
    // "end" makes the virtualizer pin the scroll position to the row under the
    // viewport (keyed via getItemKey), correcting scrollTop before paint so the
    // inserted rows extend off-screen above instead of displacing the view.
    // At the very top we use "start" instead, letting new exposures scroll in
    // like a live feed (anchorTo "end" would otherwise hold the old top row and
    // park new rows just above the fold).
    anchorTo: atTop ? "start" : "end",
    // Spacer rows live inside the same <tbody> after the (separate, sticky)
    // <thead>, so row start offsets are measured from the tbody's own origin —
    // no scrollMargin adjustment needed (the top spacer absorbs the offset).
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const padTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const padBottom =
    virtualRows.length > 0
      ? totalSize - virtualRows[virtualRows.length - 1].end
      : 0;
  const colSpan = columns.length;

  return (
    <div className="table-wrap" ref={wrapRef}>
      {/* Angled header labels, positioned over each measured column. */}
      <div className="header-overlay" style={{ width: tableWidth || undefined }}>
        <div className="header-overlay-bg" />
        {columns.map((c, i) => {
          const pos = positions[i];
          // seq label lives in its <th>; columns with no label (action columns)
          // draw nothing.
          if (!pos || c.key === "seq" || !c.label) return null;
          const left = pos.left + 4;
          // A label rotated -45° from its left-bottom anchor reaches rightward
          // by (length / √2). For the last column(s) that overflows past the
          // table's right edge into empty space. Cap each label's length to the
          // horizontal room remaining (× √2) so the diagonal's right tip stays
          // inside the table and the text truncates with an ellipsis instead.
          // The CSS max-width already caps the *vertical* rise; we take the
          // smaller of the two, leaving 6px slack so the tip clears the border.
          const room = tableWidth ? (tableWidth - left - 6) * Math.SQRT2 : 0;
          const dir = sortDirFor(c.key, sort);
          const sortable = isSortableKey(c.key);
          // Metadata labels are orderable: clicking cycles desc → asc → off.
          // The arrow shows the active direction; the diagonal label stays an
          // overlay <div> (a real button can't sit at -45° cleanly), so it
          // carries the button role/handlers itself.
          return (
            <div
              key={c.key}
              className={
                "hdr-label" +
                (sortable ? " sortable" : "") +
                (dir ? " sorted" : "")
              }
              title={
                sortable
                  ? `${c.label} — click to sort`
                  : c.label
              }
              role={sortable ? "button" : undefined}
              tabIndex={sortable ? 0 : undefined}
              aria-sort={
                dir ? (dir === "asc" ? "ascending" : "descending") : undefined
              }
              onClick={sortable ? () => onSort(c.key) : undefined}
              onKeyDown={
                sortable
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSort(c.key);
                      }
                    }
                  : undefined
              }
              style={{
                left,
                maxWidth: room > 0 ? `min(var(--hdr-rise), ${room}px)` : undefined,
              }}
            >
              {c.label}
              {dir && <span className="sort-arrow">{dir === "asc" ? "▲" : "▼"}</span>}
            </div>
          );
        })}
      </div>

      <table
        className={`data-table hs-angled dens-${density}`}
        style={{ ["--row-pad" as string]: ROW_PAD[density] }}
      >
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} style={{ width: widthFor(c.key, density) }} />
          ))}
        </colgroup>
        <thead ref={headRef}>
          <tr>
            {columns.map((c) => {
              // The seq header's label lives in its <th> (the overlay skips it),
              // so its sort affordance is wired here rather than in the overlay.
              // Other columns render their label/sort UI in the overlay above; a
              // plain <th> backs them for layout.
              const dir = c.key === "seq" ? sortDirFor(c.key, sort) : null;
              return (
                <th
                  key={c.key}
                  className={
                    c.key === "seq"
                      ? "seq sortable" + (dir ? " sorted" : "")
                      : undefined
                  }
                  title={c.key !== "seq" && c.label ? c.label : undefined}
                  aria-sort={
                    c.key === "seq" && dir
                      ? dir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                >
                  {c.key === "seq" ? (
                    <button
                      type="button"
                      className="th-sort"
                      onClick={() => onSort("seq")}
                      title="Sort by sequence number"
                    >
                      <span className="label">{c.label}</span>
                      {dir && (
                        <span className="sort-arrow">
                          {dir === "asc" ? "▲" : "▼"}
                        </span>
                      )}
                    </button>
                  ) : (
                    <span className="label">{c.label}</span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {padTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={colSpan} style={{ height: padTop, padding: 0 }} />
            </tr>
          )}
          {virtualRows.map((vr) => {
            const seq = seqNums[vr.index];
            return (
              <Row
                key={seq}
                seq={seq}
                rowIdx={vr.index}
                dataIndex={vr.index}
                measureRef={rowVirtualizer.measureElement}
                columns={columns}
                meta={metadata[String(seq)] ?? {}}
                payload={payload}
                channelColour={channelColour}
                location={location}
                camera={camera}
                date={date}
                viewerTmpl={viewerTmpl}
                quicklookTmpl={quicklookTmpl}
                copyRowTmpl={copyRowTmpl}
                linkCtx={linkCtx}
                onFoldout={setModal}
              />
            );
          })}
          {padBottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={colSpan} style={{ height: padBottom, padding: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
      {modal && (
        <CellModal
          header={modal.header}
          data={modal.data}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

export const CameraDataTable = memo(CameraDataTableInner);
