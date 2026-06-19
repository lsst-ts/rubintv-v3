import { useMemo, useRef, useState } from "react";
import { useDismiss } from "../lib/useDismiss";
import { CalendarIcon } from "./Icons";

// Date picker with two views that share one popover:
//   • months  — two side-by-side month grids (recent dates, default)
//   • heatmap — a GitHub-contributions-style year overview for scanning a wide,
//               sparse span at a glance
// A header button toggles between them; the chosen view is remembered. Clicking
// a day in the heatmap jumps to the month view centred on that date (overview →
// detail), where you confirm the pick. Clicking a day in the month grid selects
// it. Only days with data are selectable; future days disabled.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DOW = ["M", "T", "W", "T", "F", "S", "S"];

const pad2 = (n: number) => String(n).padStart(2, "0");
const key = (y: number, m: number, d: number) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

interface ViewMonth {
  y: number;
  m: number; // 0-based
}

function viewFromKey(k: string | undefined): ViewMonth {
  if (k) {
    const [y, m] = k.split("-").map(Number);
    if (Number.isFinite(y) && Number.isFinite(m)) return { y, m: m - 1 };
  }
  const now = new Date();
  return { y: now.getUTCFullYear(), m: now.getUTCMonth() };
}

function todayKey(): string {
  const now = new Date();
  return key(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

// ── Two-month view ──────────────────────────────────────────────────────────

interface MonthGridProps {
  view: ViewMonth;
  monthOffset: number;
  selected: string;
  hasData: (k: string) => boolean;
  today: string;
  showArrows: boolean;
  onStep: (months: number) => void;
  onPick: (k: string) => void;
}

function MonthGrid({
  view,
  monthOffset,
  selected,
  hasData,
  today,
  showArrows,
  onStep,
  onPick,
}: MonthGridProps) {
  const base = new Date(Date.UTC(view.y, view.m + monthOffset, 1));
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const firstDow = (base.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const daysInPrev = new Date(Date.UTC(y, m, 0)).getUTCDate();

  const cells: { d: number; out: boolean; key: string }[] = [];
  for (let i = 0; i < firstDow; i++) {
    const d = daysInPrev - firstDow + 1 + i;
    const pm = m === 0 ? 11 : m - 1;
    const py = m === 0 ? y - 1 : y;
    cells.push({ d, out: true, key: key(py, pm, d) });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ d, out: false, key: key(y, m, d) });
  }
  let nextD = 1;
  while (cells.length < 42) {
    const nm = m === 11 ? 0 : m + 1;
    const ny = m === 11 ? y + 1 : y;
    cells.push({ d: nextD, out: true, key: key(ny, nm, nextD) });
    nextD++;
  }

  return (
    <div className="dp-month">
      <div className="dp-mhead">
        <div>
          <span className="month">{MONTH_NAMES[m]}</span>
          <span className="yr">{y}</span>
        </div>
        {showArrows && (
          <div className="arrs">
            <button type="button" className="arr" onClick={() => onStep(-12)} title="Previous year">«</button>
            <button type="button" className="arr" onClick={() => onStep(-1)} title="Previous month">‹</button>
            <button type="button" className="arr" onClick={() => onStep(1)} title="Next month">›</button>
            <button type="button" className="arr" onClick={() => onStep(12)} title="Next year">»</button>
          </div>
        )}
      </div>

      <div className="dp-grid">
        {DOW.map((d, i) => (
          <div key={i} className="dow">{d}</div>
        ))}
        {cells.map((c, i) => {
          const future = c.key > today;
          const data = !c.out && hasData(c.key);
          const selectable = data && !future;
          const classes = ["dp-day"];
          if (c.out) classes.push("out");
          else if (future || !data) classes.push("disabled");
          if (data) classes.push("has-data");
          if (!c.out && c.key === today) classes.push("today");
          if (!c.out && c.key === selected) classes.push("selected");
          return (
            <div
              key={i}
              className={classes.join(" ")}
              title={c.out ? "" : data ? `${c.key} · has data` : c.key}
              onClick={() => selectable && onPick(c.key)}
            >
              <span className="num">{c.d}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Year-heatmap view ───────────────────────────────────────────────────────

interface DayCell {
  key: string;
  count: number; // -1 = no data
  col: number;
  row: number;
}

function buildYear(
  year: number,
  counts: Map<string, number>,
): { cells: DayCell[]; weeks: number; monthCols: { m: number; col: number }[] } {
  const cells: DayCell[] = [];
  const monthCols: { m: number; col: number }[] = [];
  let seenMonth = -1;

  const jan1 = new Date(Date.UTC(year, 0, 1));
  const jan1Dow = (jan1.getUTCDay() + 6) % 7;
  const last = new Date(Date.UTC(year, 11, 31));
  const totalDays = Math.round((last.getTime() - jan1.getTime()) / 86400000) + 1;

  for (let i = 0; i < totalDays; i++) {
    const date = new Date(Date.UTC(year, 0, 1 + i));
    const m = date.getUTCMonth();
    const d = date.getUTCDate();
    const dow = (date.getUTCDay() + 6) % 7;
    const col = Math.floor((jan1Dow + i) / 7);
    const k = key(year, m, d);
    cells.push({ key: k, count: counts.has(k) ? (counts.get(k) as number) : -1, col, row: dow });
    if (m !== seenMonth) {
      monthCols.push({ m, col });
      seenMonth = m;
    }
  }
  const weeks = Math.ceil((jan1Dow + totalDays) / 7);
  return { cells, weeks, monthCols };
}

// Activity tint level (0 = no exposures, 1..4 by count). The ramp is a single
// monotonically darkening teal so perceived intensity always increases.
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
      <div className="dh-grid" style={{ gridTemplateColumns: `repeat(${weeks}, 1fr)` }}>
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

// ── Picker shell ────────────────────────────────────────────────────────────

type Mode = "months" | "heatmap";
const MODE_KEY = "rubintv.datepicker.mode";

function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "heatmap" ? "heatmap" : "months";
  } catch {
    return "months";
  }
}

interface Props {
  dates: string[];
  counts: Record<string, number>;
  value: string;
  onChange: (date: string) => void;
}

export function DatePicker({ dates, counts, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(readMode);
  const [view, setView] = useState<ViewMonth>(() => viewFromKey(value));
  const rootRef = useRef<HTMLSpanElement | null>(null);
  useDismiss(open, rootRef, () => setOpen(false));

  const dataSet = useMemo(() => new Set(dates), [dates]);
  const hasData = useMemo(() => (k: string) => dataSet.has(k), [dataSet]);
  const countMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of dates) m.set(d, counts[d] ?? 0);
    return m;
  }, [dates, counts]);
  const years = useMemo(() => {
    const ys = new Set<number>();
    for (const d of dates) {
      const y = Number(d.slice(0, 4));
      if (Number.isFinite(y)) ys.add(y);
    }
    return [...ys].sort((a, b) => b - a);
  }, [dates]);

  const today = useMemo(todayKey, []);
  const latest = dates[0] ?? "";

  const setModePersisted = (next: Mode) => {
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // ignore
    }
    setMode(next);
  };

  const step = (months: number) => {
    setView((v) => {
      const nm = v.m + months;
      return { y: v.y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 };
    });
  };

  // Month-grid pick: commit and close.
  const pickDay = (k: string) => {
    onChange(k);
    setOpen(false);
  };

  // Heatmap day click: jump to the month view centred on that date, where the
  // user confirms the pick (overview → detail). Doesn't commit yet.
  const jumpToMonth = (k: string) => {
    setView(viewFromKey(k));
    setModePersisted("months");
  };

  const openPicker = () => {
    setView(viewFromKey(value || latest));
    setOpen((o) => !o);
  };

  return (
    <span className="date-cluster" ref={rootRef}>
      <button
        type="button"
        className="date-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openPicker}
      >
        <CalendarIcon />
        <span>{value || "select date"}</span>
      </button>

      {open && (
        <div className="date-pop" role="dialog" aria-label="Choose date">
          <div className="dp-head">
            <div className="dp-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "months"}
                className={"dp-tab" + (mode === "months" ? " active" : "")}
                onClick={() => setModePersisted("months")}
              >
                Months
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "heatmap"}
                className={"dp-tab" + (mode === "heatmap" ? " active" : "")}
                onClick={() => setModePersisted("heatmap")}
              >
                Heatmap
              </button>
            </div>
            <span className="dp-head-val">{value}</span>
            {latest && (
              <span
                className="today-link"
                role="button"
                tabIndex={0}
                onClick={() => pickDay(latest)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") pickDay(latest);
                }}
              >
                jump to latest
              </span>
            )}
          </div>

          {mode === "months" ? (
            <div className="dp-two-grids">
              <MonthGrid
                view={view}
                monthOffset={0}
                selected={value}
                hasData={hasData}
                today={today}
                showArrows
                onStep={step}
                onPick={pickDay}
              />
              <MonthGrid
                view={view}
                monthOffset={1}
                selected={value}
                hasData={hasData}
                today={today}
                showArrows={false}
                onStep={step}
                onPick={pickDay}
              />
            </div>
          ) : (
            <>
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
                      onPick={jumpToMonth}
                    />
                  ))
                )}
              </div>
              <div className="dh-foot">
                <span className="dh-legend">
                  <span>less</span>
                  <i className="dh-day lv-1" />
                  <i className="dh-day lv-2" />
                  <i className="dh-day lv-3" />
                  <i className="dh-day lv-4" />
                  <span>more</span>
                </span>
                <span className="dh-hint">click a day to open its month</span>
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}
