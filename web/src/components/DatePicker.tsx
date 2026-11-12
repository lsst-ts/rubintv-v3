import { useEffect, useMemo, useRef, useState } from "react";
import { useDismiss } from "../lib/useDismiss";
import { currentDayObs } from "../lib/queryClient";
import { CalendarIcon, FilmIcon } from "./Icons";

// Date picker with two views that share one popover:
//   • months  — two side-by-side month grids (recent dates, default), the
//               newest month on the right
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

const NO_PER_DAY: Record<string, string[]> = {};

// A day's tooltip names the per-night channels it has an artifact on.
const perDaySuffix = (titles: string[] | undefined) =>
  titles?.length ? ` · ${titles.join(", ")}` : "";

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

function shiftMonth(v: ViewMonth, months: number): ViewMonth {
  const nm = v.m + months;
  return { y: v.y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 };
}

// The two grids show `view` and the month after it. A date opens in the left
// grid unless the right one would then be a month that hasn't started; then
// it opens in the right, so the newest nights don't sit beside an empty
// future month.
function viewFor(k: string, today: string): ViewMonth {
  const v = viewFromKey(k);
  const t = viewFromKey(today);
  return v.y * 12 + v.m >= t.y * 12 + t.m ? shiftMonth(v, -1) : v;
}

// "Today" for the picker is the current *observing day* (day_obs, noon-UTC
// rollover) — the calendar cells are day_obs dates, so comparing against a
// plain calendar-UTC date would mismatch. Returned as a YYYY-MM-DD key to match
// the cells' `key(...)` format.
function todayKey(): string {
  return currentDayObs();
}

// Re-read the current day_obs on an interval so an always-on display (open
// across the noon-UTC rollover) doesn't keep yesterday frozen as "today",
// which would render the new observing day disabled/future and unselectable.
function useCurrentDayObsKey(): string {
  const [today, setToday] = useState(todayKey);
  useEffect(() => {
    const id = setInterval(() => {
      const next = todayKey();
      setToday((prev) => (prev === next ? prev : next));
    }, 60_000);
    return () => clearInterval(id);
  }, []);
  return today;
}

// ── Two-month view ──────────────────────────────────────────────────────────

interface MonthGridProps {
  view: ViewMonth;
  monthOffset: number;
  selected: string;
  hasData: (k: string) => boolean;
  maxSeq: Record<string, number>;
  // All Sky cameras have no per-seq table, so show only the has-data dot.
  showSeq: boolean;
  perDay: Record<string, string[]>;
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
  maxSeq,
  showSeq,
  perDay,
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

  // Only the month's own days. The neighbouring months' days used to pad the
  // grid, greyed out and without their data, so they read as empty nights;
  // instead the 1st is placed under its weekday.
  const cells = Array.from({ length: daysInMonth }, (_, i) => ({
    d: i + 1,
    key: key(y, m, i + 1),
  }));

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
        {cells.map((c) => {
          const future = c.key > today;
          const data = hasData(c.key);
          const selectable = data && !future;
          // Max seq for the day (per-seq cameras only). The seq number is the
          // data cue for those; All Sky (no seq) keeps the has-data dot.
          const seq = data && showSeq ? maxSeq[c.key] : undefined;
          const classes = ["dp-day"];
          if (future || !data) classes.push("disabled");
          if (data && !showSeq) classes.push("has-data");
          const extras = data ? perDay[c.key] : undefined;
          if (extras?.length) classes.push("has-per-day");
          if (c.key === today) classes.push("today");
          if (c.key === selected) classes.push("selected");
          const title = data
            ? (seq !== undefined
                ? `${c.key} · max seq ${seq}`
                : showSeq
                  ? `${c.key} · has data`
                  : `${c.key} · movie`) + perDaySuffix(extras)
            : c.key;
          const style = c.d === 1 ? { gridColumnStart: firstDow + 1 } : undefined;
          // Selectable days are real <button>s so they're keyboard-operable
          // (the grid was mouse-only — a <div onClick> can't be tabbed to or
          // activated with Enter/Space). Non-selectable cells stay inert divs.
          const inner = (
            <>
              <span className="num">{c.d}</span>
              {seq !== undefined && <span className="ct">{seq}</span>}
            </>
          );
          return selectable ? (
            <button
              key={c.key}
              type="button"
              className={classes.join(" ")}
              style={style}
              title={title}
              onClick={() => onPick(c.key)}
            >
              {inner}
            </button>
          ) : (
            <div key={c.key} className={classes.join(" ")} style={style} title={title}>
              {inner}
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
  col: number; // weekday, Mon=0
  row: number; // week index within the month
}

// A mini month grid: day cells in 7 weekday columns × up to 6 week rows.
function buildMonth(
  year: number,
  m: number,
  counts: Map<string, number>,
): DayCell[] {
  const first = new Date(Date.UTC(year, m, 1));
  const firstDow = (first.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
  const cells: DayCell[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const idx = firstDow + (d - 1);
    const k = key(year, m, d);
    cells.push({
      key: k,
      count: counts.has(k) ? (counts.get(k) as number) : -1,
      col: idx % 7,
      row: Math.floor(idx / 7),
    });
  }
  return cells;
}

// Activity tint level. Count mode: 0 = no exposures, 1..4 by count, a single
// monotonically darkening teal. Binary mode (All Sky): on/off only.
function level(count: number, binary: boolean): string {
  if (count < 0) return "lv-none";
  if (binary) return "lv-on";
  if (count === 0) return "lv-0";
  if (count < 50) return "lv-1";
  if (count < 250) return "lv-2";
  if (count < 1000) return "lv-3";
  return "lv-4";
}

interface MiniMonthProps {
  year: number;
  month: number;
  counts: Map<string, number>;
  perDay: Record<string, string[]>;
  selected: string;
  today: string;
  binary: boolean;
  onPickDay: (k: string) => void;
  onJumpMonth: (year: number, month: number) => void;
}

function MiniMonth({
  year,
  month,
  counts,
  perDay,
  selected,
  today,
  binary,
  onPickDay,
  onJumpMonth,
}: MiniMonthProps) {
  const cells = useMemo(
    () => buildMonth(year, month, counts),
    [year, month, counts],
  );
  const label = `${MONTH_ABBR[month]} ${year}`;
  // The whole mini-month is the month-jump target; clicking a day inside selects
  // that date instead (the day handler stops propagation). role=button keeps it
  // keyboard-operable without nesting buttons (the day cells are buttons too).
  const jump = () => onJumpMonth(year, month);
  return (
    <div
      className="dh-mini"
      role="button"
      tabIndex={0}
      title={`Open ${label} in the month view`}
      onClick={jump}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          jump();
        }
      }}
    >
      <div className="dh-mini-label">
        {MONTH_ABBR[month]}
        <span className="dh-mini-jump" aria-hidden="true">›</span>
      </div>
      <div className="dh-mini-grid">
        {cells.map((c) => {
          const future = c.key > today;
          const selectable = c.count >= 0 && !future;
          const extras = selectable ? perDay[c.key] : undefined;
          const cls = [
            "dh-day",
            level(future ? -1 : c.count, binary),
            extras?.length ? "has-per-day" : "",
            c.key === selected ? "selected" : "",
            c.key === today ? "today" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const title =
            c.count < 0
              ? c.key
              : (binary
                  ? `${c.key} · movie`
                  : `${c.key} · ${c.count} exposure${c.count === 1 ? "" : "s"}`) +
                perDaySuffix(extras);
          return (
            <button
              key={c.key}
              type="button"
              className={cls}
              style={{ gridColumnStart: c.col + 1, gridRowStart: c.row + 1 }}
              disabled={!selectable}
              title={title}
              onClick={(e) => {
                e.stopPropagation(); // don't also trigger the month jump
                if (selectable) onPickDay(c.key);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

interface YearBlockProps {
  year: number;
  counts: Map<string, number>;
  perDay: Record<string, string[]>;
  selected: string;
  today: string;
  binary: boolean;
  // Index of this year among the rendered years (for alternating stripes).
  stripe: number;
  onPickDay: (k: string) => void;
  onJumpMonth: (year: number, month: number) => void;
}

// A year as 12 mini-months laid out horizontally, 6 across × 2 rows.
function YearBlock({
  year,
  counts,
  perDay,
  selected,
  today,
  binary,
  stripe,
  onPickDay,
  onJumpMonth,
}: YearBlockProps) {
  return (
    <div className={"dh-year" + (stripe % 2 ? " alt" : "")}>
      <div className="dh-year-label">{year}</div>
      <div className="dh-months-grid">
        {Array.from({ length: 12 }, (_, m) => (
          <MiniMonth
            key={m}
            year={year}
            month={m}
            counts={counts}
            perDay={perDay}
            selected={selected}
            today={today}
            binary={binary}
            onPickDay={onPickDay}
            onJumpMonth={onJumpMonth}
          />
        ))}
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
  maxSeq: Record<string, number>;
  // True when the dates are nights with a movie (All Sky, a per-day channel)
  // rather than nights with exposures: month cells show only a dot, no seq,
  // the heatmap is binary, and the picker takes the movie colour and icon so
  // the two kinds of date can't be mistaken for each other.
  movies?: boolean;
  // What the dates belong to (a camera, or a per-day channel), shown as the
  // popover's heading with what its days mean.
  title?: string;
  // Days that also have a per-night artifact (e.g. Tonight's Movie), with
  // the titles of the channels that have one: such days carry a mark, keyed
  // in the heading, so they can be found without the channel's own picker.
  perDay?: Record<string, string[]>;
  value: string;
  // Whether `value` is the current observing day (computed by the caller via
  // currentDayObs, the UTC−12 rule). Tints the trigger chip so a date that
  // isn't tonight reads as historical at a glance.
  isCurrentDayObs?: boolean;
  onChange: (date: string) => void;
}

export function DatePicker({
  dates,
  counts,
  maxSeq,
  movies = false,
  title,
  perDay = NO_PER_DAY,
  value,
  isCurrentDayObs = false,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(readMode);
  const [view, setView] = useState<ViewMonth>(() => viewFor(value, todayKey()));
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

  const today = useCurrentDayObsKey();
  const latest = dates[0] ?? "";

  // The heading's key for the per-night mark: the one channel's title, or a
  // general name when the marked days span several.
  const perDayKey = useMemo(() => {
    const titles = new Set(Object.values(perDay).flat());
    if (titles.size === 0) return null;
    return titles.size === 1 ? [...titles][0] : "per-night data";
  }, [perDay]);

  const setModePersisted = (next: Mode) => {
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // ignore
    }
    setMode(next);
  };

  const step = (months: number) => {
    setView((v) => shiftMonth(v, months));
  };

  // Selecting a day (in either view) commits and closes.
  const pickDay = (k: string) => {
    onChange(k);
    setOpen(false);
  };

  // Heatmap month-title click: switch to the Months view showing that month
  // (overview → detail), without committing a date.
  const jumpToMonthView = (y: number, m: number) => {
    setView(viewFor(key(y, m, 1), today));
    setModePersisted("months");
  };

  const openPicker = () => {
    setView(viewFor(value || latest, today));
    setOpen((o) => !o);
  };

  // The trigger's tooltip spells out what its live/past tint means.
  const triggerTitle = !value
    ? undefined
    : movies
      ? isCurrentDayObs
        ? "Movie for the current observing night."
        : "Movie for a past night, not the current observing night."
      : isCurrentDayObs
        ? "Current observing day — this table updates live as new exposures arrive."
        : "Historical day — this is not the current observing day, so the table is not updating live.";

  return (
    <span className={`date-cluster${movies ? " is-movies" : ""}`} ref={rootRef}>
      <button
        type="button"
        className={
          "date-trigger" +
          (value
            ? isCurrentDayObs
              ? " is-live-day"
              : " is-past-day"
            : "")
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        title={triggerTitle}
        onClick={openPicker}
      >
        {movies ? <FilmIcon /> : <CalendarIcon />}
        <span>{value || "select date"}</span>
      </button>

      {open && (
        <div
          className="date-pop"
          role="dialog"
          aria-label={title ? `Choose date: ${title}` : "Choose date"}
        >
          {title && (
            <div className="dp-title">
              {movies ? <FilmIcon /> : <CalendarIcon />}
              <span className="dp-title-name">{title}</span>
              <span className="dp-title-sub">
                {movies ? "nights with a movie" : "nights with exposures"}
              </span>
              {perDayKey && (
                <span className="dp-title-key">
                  <i className="dp-per-day-mark" aria-hidden="true" />
                  {perDayKey}
                </span>
              )}
            </div>
          )}
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
                  if (e.key === "Enter" || e.key === " ") {
                    // Space would otherwise scroll the page as well as activate.
                    e.preventDefault();
                    pickDay(latest);
                  }
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
                maxSeq={maxSeq}
                showSeq={!movies}
                perDay={perDay}
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
                maxSeq={maxSeq}
                showSeq={!movies}
                perDay={perDay}
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
                  years.map((y, i) => (
                    <YearBlock
                      key={y}
                      year={y}
                      counts={countMap}
                      perDay={perDay}
                      selected={value}
                      today={today}
                      binary={movies}
                      stripe={i}
                      onPickDay={pickDay}
                      onJumpMonth={jumpToMonthView}
                    />
                  ))
                )}
              </div>
              <div className="dh-foot">
                {movies ? (
                  <span className="dh-legend">
                    <i className="dh-day lv-on" />
                    <span>has movie</span>
                  </span>
                ) : (
                  <span className="dh-legend">
                    <span>less</span>
                    <i className="dh-day lv-1" />
                    <i className="dh-day lv-2" />
                    <i className="dh-day lv-3" />
                    <i className="dh-day lv-4" />
                    <span>more</span>
                  </span>
                )}
                <span className="dh-hint">
                  click a day to select · a month to open it
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}
