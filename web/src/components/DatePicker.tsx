import { useMemo, useRef, useState } from "react";
import { useDismiss } from "../lib/useDismiss";
import { CalendarIcon } from "./Icons";

// Year-heatmap date picker (GitHub-contributions style): one compact block per
// year with data, each a 7-row grid of day cells laid out by week-column and
// tinted by activity (exposure count). Scans a wide, sparse time span at a
// glance without a month grid per month. Click a day with data to select it.
//
// Driven by the real calendar: `dates` are the days with data, `counts` the
// per-date exposure counts (CalendarOut). Only days with data are selectable.

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const pad2 = (n: number) => String(n).padStart(2, "0");
const keyOf = (y: number, m: number, d: number) =>
  `${y}-${pad2(m + 1)}-${pad2(d)}`;

interface DayCell {
  key: string;
  count: number; // -1 = no data
  // Grid position within the year: column = week index, row = weekday (Mon=0).
  col: number;
  row: number;
  month: number;
}

// Build the per-year cell grid. Columns are ISO-ish weeks (Mon-first) spanning
// the year; rows are weekdays. Each in-year day gets a cell; data days carry
// their count.
function buildYear(
  year: number,
  counts: Map<string, number>,
): { cells: DayCell[]; weeks: number; monthCols: { m: number; col: number }[] } {
  const cells: DayCell[] = [];
  const monthCols: { m: number; col: number }[] = [];
  let seenMonth = -1;

  const jan1 = new Date(Date.UTC(year, 0, 1));
  // Weekday of Jan 1, Mon=0..Sun=6.
  const jan1Dow = (jan1.getUTCDay() + 6) % 7;

  const last = new Date(Date.UTC(year, 11, 31));
  const totalDays =
    Math.round((last.getTime() - jan1.getTime()) / 86400000) + 1;

  for (let i = 0; i < totalDays; i++) {
    const date = new Date(Date.UTC(year, 0, 1 + i));
    const m = date.getUTCMonth();
    const d = date.getUTCDate();
    const dow = (date.getUTCDay() + 6) % 7;
    const col = Math.floor((jan1Dow + i) / 7);
    const k = keyOf(year, m, d);
    const count = counts.has(k) ? (counts.get(k) as number) : -1;
    cells.push({ key: k, count, col, row: dow, month: m });
    // Record the column where each month first appears, for month labels.
    if (m !== seenMonth) {
      monthCols.push({ m, col });
      seenMonth = m;
    }
  }
  const weeks = Math.ceil((jan1Dow + totalDays) / 7);
  return { cells, weeks, monthCols };
}

// Activity tint level (0 = no data, 1..4 by count) → CSS class.
function level(count: number): string {
  if (count < 0) return "lv-none";
  if (count === 0) return "lv-0";
  if (count < 50) return "lv-1";
  if (count < 250) return "lv-2";
  if (count < 1000) return "lv-3";
  return "lv-4";
}

interface YearBlockProps {
  year: number;
  counts: Map<string, number>;
  selected: string;
  today: string;
  onPick: (k: string) => void;
}

function YearBlock({ year, counts, selected, today, onPick }: YearBlockProps) {
  const { cells, weeks, monthCols } = useMemo(
    () => buildYear(year, counts),
    [year, counts],
  );

  return (
    <div className="dh-year">
      <div className="dh-year-label">{year}</div>
      <div
        className="dh-grid"
        style={{ gridTemplateColumns: `repeat(${weeks}, 1fr)` }}
      >
        {/* Month labels along the top, positioned at each month's first week. */}
        <div className="dh-months">
          {monthCols.map(({ m, col }) => (
            <span key={m} className="dh-month" style={{ gridColumnStart: col + 1 }}>
              {MONTH_ABBR[m]}
            </span>
          ))}
        </div>
        {cells.map((c) => {
          const future = c.key > today;
          const selectable = c.count >= 0 && !future;
          const cls = [
            "dh-day",
            level(future ? -1 : c.count),
            c.key === selected ? "selected" : "",
            c.key === today ? "today" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={c.key}
              type="button"
              className={cls}
              style={{ gridColumnStart: c.col + 1, gridRowStart: c.row + 2 }}
              disabled={!selectable}
              title={
                c.count >= 0
                  ? `${c.key} · ${c.count} exposure${c.count === 1 ? "" : "s"}`
                  : c.key
              }
              onClick={() => selectable && onPick(c.key)}
            />
          );
        })}
      </div>
    </div>
  );
}

interface Props {
  dates: string[];
  counts: Record<string, number>;
  value: string;
  onChange: (date: string) => void;
}

export function DatePicker({ dates, counts, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  useDismiss(open, rootRef, () => setOpen(false));

  const countMap = useMemo(() => {
    const m = new Map<string, number>();
    // Every date with data gets at least 0; counts override where present.
    for (const d of dates) m.set(d, counts[d] ?? 0);
    return m;
  }, [dates, counts]);

  // Years that have data, newest first.
  const years = useMemo(() => {
    const ys = new Set<number>();
    for (const d of dates) {
      const y = Number(d.slice(0, 4));
      if (Number.isFinite(y)) ys.add(y);
    }
    return [...ys].sort((a, b) => b - a);
  }, [dates]);

  const today = useMemo(() => {
    const now = new Date();
    return keyOf(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }, []);
  const latest = dates[0] ?? "";

  const pick = (k: string) => {
    onChange(k);
    setOpen(false);
  };

  return (
    <span className="date-cluster" ref={rootRef}>
      <button
        type="button"
        className="date-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <CalendarIcon />
        <span>{value || "select date"}</span>
      </button>

      {open && (
        <div className="date-pop dh-pop" role="dialog" aria-label="Choose date">
          <div className="dh-scroll">
            {years.length === 0 ? (
              <div className="dh-empty">No dates with data.</div>
            ) : (
              years.map((y) => (
                <YearBlock
                  key={y}
                  year={y}
                  counts={countMap}
                  selected={value}
                  today={today}
                  onPick={pick}
                />
              ))
            )}
          </div>
          <div className="dh-foot">
            <span className="dh-legend">
              <span>less</span>
              <i className="dh-day lv-0" />
              <i className="dh-day lv-1" />
              <i className="dh-day lv-2" />
              <i className="dh-day lv-3" />
              <i className="dh-day lv-4" />
              <span>more</span>
            </span>
            <span className="dh-foot-val">{value}</span>
            {latest && (
              <span
                className="today-link"
                role="button"
                tabIndex={0}
                onClick={() => pick(latest)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") pick(latest);
                }}
              >
                jump to latest
              </span>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
