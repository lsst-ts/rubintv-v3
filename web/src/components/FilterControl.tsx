import { useEffect, useMemo, useRef, useState } from "react";
import type { Metadata } from "../lib/types";
import {
  OPS_BY_TYPE,
  inferType,
  opLabel,
  sampleValues,
  type Filter,
  type FilterType,
} from "../lib/filters";
import { useDismiss } from "../lib/useDismiss";

// Highlight the matched substring of a column label.
function highlight(label: string, q: string) {
  if (!q) return label;
  const i = label.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return label;
  return (
    <>
      {label.slice(0, i)}
      <mark>{label.slice(i, i + q.length)}</mark>
      {label.slice(i + q.length)}
    </>
  );
}

// Fuzzy-ish column combobox: substring match on the label, keyboard navigable.
function ColumnCombo({
  columns,
  typeOf,
  value,
  onChange,
}: {
  columns: string[];
  typeOf: (c: string) => FilterType;
  value: string;
  onChange: (col: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [kbdIdx, setKbdIdx] = useState(0);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  useDismiss(open, rootRef, () => {
    setOpen(false);
    setQuery("");
  });

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return columns;
    return columns.filter((c) => c.toLowerCase().includes(q));
  }, [query, columns]);

  useEffect(() => setKbdIdx(0), [query]);

  const pick = (col: string) => {
    onChange(col);
    setOpen(false);
    setQuery("");
  };

  const display = open ? query : value;

  return (
    <span className="filter-combo" ref={rootRef}>
      <input
        value={display}
        placeholder="search columns…"
        aria-label="Filter column"
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setKbdIdx((i) => Math.min(matches.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setKbdIdx((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && matches[kbdIdx]) {
            e.preventDefault();
            pick(matches[kbdIdx]);
          } else if (e.key === "Escape") {
            setOpen(false);
            setQuery("");
          }
        }}
      />
      {open && (
        <div className="list" onMouseDown={(e) => e.preventDefault()}>
          <div className="count">
            {matches.length} of {columns.length} columns
          </div>
          {matches.length === 0 && (
            <div className="empty">no columns match “{query}”</div>
          )}
          {matches.map((c, i) => (
            <div
              key={c}
              className={"item" + (i === kbdIdx ? " kbd-active" : "")}
              onMouseEnter={() => setKbdIdx(i)}
              onClick={() => pick(c)}
            >
              <span className="name">{highlight(c, query)}</span>
              <span className="type-pill">{typeOf(c)}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

// The "filter" button + add-filter popover.
export function FilterControl({
  columns,
  metadata,
  filters,
  setFilters,
}: {
  columns: string[];
  metadata: Metadata;
  filters: Filter[];
  setFilters: (f: Filter[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftCol, setDraftCol] = useState("");
  const [draftOp, setDraftOp] = useState("=");
  const [draftVal, setDraftVal] = useState("");
  const rootRef = useRef<HTMLSpanElement | null>(null);
  useDismiss(open, rootRef, () => setOpen(false));

  const typeOf = useMemo(
    () => (c: string) => inferType(metadata, c),
    [metadata],
  );

  // Default the draft column to the first available one when the popover opens
  // (by then the async metadata columns have loaded), and re-default if the
  // current draft column is no longer offered.
  useEffect(() => {
    if (!open || columns.length === 0) return;
    if (!draftCol || !columns.includes(draftCol)) setDraftCol(columns[0]);
  }, [open, columns, draftCol]);

  const draftType = draftCol ? typeOf(draftCol) : "string";
  const availableOps = OPS_BY_TYPE[draftType];

  // Snap the op to a valid one for the column type.
  useEffect(() => {
    if (!availableOps.some(([op]) => op === draftOp)) {
      setDraftOp(availableOps[0][0]);
    }
  }, [draftType, availableOps, draftOp]);

  const suggestions = useMemo(
    () => (draftCol ? sampleValues(metadata, draftCol) : []),
    [metadata, draftCol],
  );

  const apply = () => {
    if (!draftCol || !draftVal.trim()) return;
    setFilters([...filters, { col: draftCol, op: draftOp, value: draftVal.trim() }]);
    setDraftVal("");
    setOpen(false);
  };

  const placeholder =
    draftOp === "between"
      ? "lo, hi"
      : draftOp === "in"
        ? "a, b, c"
        : (suggestions[0] ?? "value");

  return (
    <span className="filter-cluster" ref={rootRef}>
      <button
        type="button"
        className={"filter-btn" + (filters.length ? " active" : "")}
        aria-expanded={open}
        aria-label="Add or edit filters"
        onClick={() => setOpen((v) => !v)}
        title="Add or edit filters"
      >
        <span>filter</span>
        {filters.length > 0 && <span className="count">{filters.length}</span>}
        <span className="caret">▾</span>
      </button>

      {open && (
        <div className="filter-pop" role="dialog" aria-label="Add filter">
          <h4>Add filter</h4>
          <div className="col-row">
            <label>column</label>
            <ColumnCombo
              columns={columns}
              typeOf={typeOf}
              value={draftCol}
              onChange={(k) => {
                setDraftCol(k);
                setDraftVal("");
              }}
            />
          </div>
          <div className="row">
            <label>op</label>
            <select
              className="op"
              aria-label="Operator"
              value={draftOp}
              onChange={(e) => setDraftOp(e.target.value)}
            >
              {availableOps.map(([op, lbl]) => (
                <option key={op} value={op}>
                  {lbl}
                </option>
              ))}
            </select>
            <input
              placeholder={placeholder}
              value={draftVal}
              aria-label="Filter value"
              onChange={(e) => setDraftVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apply()}
            />
          </div>
          {suggestions.length > 0 && draftOp !== "between" && (
            <>
              <div className="hint">common values:</div>
              <div className="suggestions">
                {suggestions.map((s) => (
                  <span
                    key={s}
                    className="suggestion"
                    onClick={() =>
                      setDraftVal((prev) =>
                        draftOp === "in" && prev ? `${prev}, ${s}` : s,
                      )
                    }
                  >
                    {s}
                  </span>
                ))}
              </div>
            </>
          )}
          <button
            type="button"
            className="apply"
            disabled={!draftVal.trim()}
            onClick={apply}
          >
            add filter
          </button>
        </div>
      )}
    </span>
  );
}

// The active-filter chip strip.
export function FilterBar({
  metadata,
  filters,
  setFilters,
}: {
  metadata: Metadata;
  filters: Filter[];
  setFilters: (f: Filter[]) => void;
}) {
  if (filters.length === 0) return null;
  return (
    <div className="filter-bar">
      <span className="label">filters</span>
      {filters.map((f, i) => (
        <span key={i} className="filter-chip">
          <span className="col">{f.col}</span>
          <span className="op">{opLabel(inferType(metadata, f.col), f.op)}</span>
          <span className="val">{f.value}</span>
          <span
            className="x"
            role="button"
            title="Remove filter"
            onClick={() => setFilters(filters.filter((_, j) => j !== i))}
          >
            ×
          </span>
        </span>
      ))}
      {filters.length > 1 && (
        <span className="filter-clear" role="button" onClick={() => setFilters([])}>
          clear all
        </span>
      )}
    </div>
  );
}
