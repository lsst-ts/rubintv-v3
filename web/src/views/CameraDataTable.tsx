import { memo } from "react";
import { Link } from "react-router-dom";
import type { DatePayload, Metadata } from "../lib/types";
import { useAngledHeaders } from "../lib/useAngledHeaders";
import { fillTemplate } from "../lib/links";
import { CopyButton } from "../components/CopyButton";

export type Density = "compact" | "regular" | "comfy";
const ROW_PAD: Record<Density, string> = {
  compact: "3px 8px",
  regular: "6px 8px",
  comfy: "10px 10px",
};

export interface Column {
  key: string;
  label: string;
}

// Fixed per-column width (the table is table-layout:fixed). Channel columns are
// just one image chip + padding; without an explicit width they stretch to
// absorb leftover space. Action columns size to their link text; metadata
// columns get a compact default (values are short — angled labels float above
// in an overlay, so the column needn't fit the label).
function widthFor(key: string): string {
  if (key === "seq") return "64px";
  if (key.startsWith("ch:")) return "44px"; // one chip + padding
  if (key === "viewer" || key === "quicklook" || key === "copy") return "84px";
  return "92px";
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

interface Props {
  columns: Column[];
  seqNums: number[];
  metadata: Metadata;
  payload: DatePayload | undefined;
  channelColour: Record<string, string>;
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

  return (
    <div className="table-wrap" ref={wrapRef}>
      {/* Angled header labels, positioned over each measured column. */}
      <div className="header-overlay" style={{ width: tableWidth || undefined }}>
        <div className="header-overlay-bg" />
        {columns.map((c, i) => {
          const pos = positions[i];
          if (!pos || c.key === "seq") return null; // seq label lives in its <th>
          return (
            <div
              key={c.key}
              className="hdr-label"
              title={c.label}
              style={{ left: pos.left + 4 }}
            >
              {c.label}
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
            <col key={c.key} style={{ width: widthFor(c.key) }} />
          ))}
        </colgroup>
        <thead ref={headRef}>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={c.key === "seq" ? "seq" : undefined}
                title={c.key !== "seq" ? c.label : undefined}
              >
                <span className="label">{c.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {seqNums.map((seq, rowIdx) => {
            const meta = metadata[String(seq)] ?? {};
            return (
              <tr key={seq} className={rowIdx === 0 ? "newest" : undefined}>
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
                      <td key="viewer">
                        <a
                          href={fillTemplate(
                            viewerTmpl!,
                            date,
                            seq,
                            linkCtx(meta.controller),
                          )}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Viewer
                        </a>
                      </td>
                    );
                  }
                  if (c.key === "quicklook") {
                    return (
                      <td key="quicklook">
                        <a
                          href={fillTemplate(
                            quicklookTmpl!,
                            date,
                            seq,
                            linkCtx(meta.controller),
                          )}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Quicklook
                        </a>
                      </td>
                    );
                  }
                  if (c.key === "copy") {
                    return (
                      <td key="copy">
                        <CopyButton
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
                  // Metadata cell.
                  const col = c.key.slice(5);
                  const { display, title } = formatCell(meta[col]);
                  return (
                    <td
                      key={c.key}
                      title={title}
                      style={{
                        color:
                          display === "—" ? "var(--ink-soft)" : "var(--ink)",
                        cursor: title ? "help" : undefined,
                      }}
                    >
                      {display}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const CameraDataTable = memo(CameraDataTableInner);
