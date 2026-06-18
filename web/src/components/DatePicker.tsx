import { useMemo, useRef, useState } from "react";
import { useDismiss } from "../lib/useDismiss";
import { CalendarIcon } from "./Icons";

// Two-month calendar date picker (the design's "two-months" DatePicker, the
// variant embedded in Camera Table - Sidebar v2). Driven by the real calendar:
// only dates the camera actually has data for are selectable; other past days
// are dimmed, future days disabled. Selecting a day calls onChange with a
// "YYYY-MM-DD" key.
//
// Per-night image counts aren't in the calendar API yet — the day cell leaves
// room for a `.ct` count line so it can be filled in if that's ever exposed.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW = ["M", "T", "W", "T", "F", "S", "S"];

const pad2 = (n: number) => String(n).padStart(2, "0");
const key = (y: number, m: number, d: number) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

// Today as a UTC YYYY-MM-DD (dayObs is UTC).
function todayKey(): string {
  const now = new Date();
  return key(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

interface ViewMonth {
  y: number;
  m: number; // 0-based
}

// Parse a YYYY-MM-DD into the month view it belongs to (left grid). Falls back
// to the current month.
function viewFromKey(k: string | undefined): ViewMonth {
  if (k) {
    const [y, m] = k.split("-").map(Number);
    if (Number.isFinite(y) && Number.isFinite(m)) return { y, m: m - 1 };
  }
  const now = new Date();
  return { y: now.getUTCFullYear(), m: now.getUTCMonth() };
}

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
  // Monday-first: getUTCDay() is 0=Sun..6=Sat; shift so Mon=0.
  const firstDow = (base.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const daysInPrev = new Date(Date.UTC(y, m, 0)).getUTCDate();

  // 6 weeks × 7 days = 42 cells, with leading/trailing days from adjacent months.
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
            <button type="button" className="arr" onClick={() => onStep(-12)} title="Previous year">
              «
            </button>
            <button type="button" className="arr" onClick={() => onStep(-1)} title="Previous month">
              ‹
            </button>
            <button type="button" className="arr" onClick={() => onStep(1)} title="Next month">
              ›
            </button>
            <button type="button" className="arr" onClick={() => onStep(12)} title="Next year">
              »
            </button>
          </div>
        )}
      </div>

      <div className="dp-grid">
        {DOW.map((d, i) => (
          <div key={i} className="dow">
            {d}
          </div>
        ))}
        {cells.map((c, i) => {
          const future = c.key > today;
          const data = !c.out && hasData(c.key);
          // Only days with data are selectable; out-of-month, future, and
          // no-data past days are not.
          const selectable = data && !future;
          const classes = ["dp-day"];
          if (c.out) classes.push("out");
          else if (future) classes.push("disabled");
          else if (!data) classes.push("disabled");
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
              {/* Room for a per-night count when the API exposes one. */}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface Props {
  // Dates with data ("YYYY-MM-DD"), newest first as the calendar returns them.
  dates: string[];
  // Currently-selected date.
  value: string;
  onChange: (date: string) => void;
}

export function DatePicker({ dates, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ViewMonth>(() => viewFromKey(value));
  const rootRef = useRef<HTMLSpanElement | null>(null);
  useDismiss(open, rootRef, () => setOpen(false));

  const dataSet = useMemo(() => new Set(dates), [dates]);
  const hasData = useMemo(() => (k: string) => dataSet.has(k), [dataSet]);
  const today = todayKey();
  // Newest date with data — the picker's "jump to latest" target.
  const latest = dates[0] ?? "";

  const step = (months: number) => {
    setView((v) => {
      const nm = v.m + months;
      return { y: v.y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 };
    });
  };

  const pick = (k: string) => {
    onChange(k);
    setOpen(false);
  };

  const openPicker = () => {
    // Re-centre the view on the selected date each time it opens.
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
        <div className="date-pop v-two-months" role="dialog" aria-label="Choose date">
          <div className="dp-two">
            <div className="dp-two-grids">
              <MonthGrid
                view={view}
                monthOffset={0}
                selected={value}
                hasData={hasData}
                today={today}
                showArrows
                onStep={step}
                onPick={pick}
              />
              <MonthGrid
                view={view}
                monthOffset={1}
                selected={value}
                hasData={hasData}
                today={today}
                showArrows={false}
                onStep={step}
                onPick={pick}
              />
            </div>
            <div className="dp-two-foot">
              <input className="input" value={value} readOnly aria-label="Selected date" />
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
        </div>
      )}
    </span>
  );
}
