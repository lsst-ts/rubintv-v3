import { useCallback, useEffect, useState } from "react";
import {
  INTRO_END,
  LINE_WIDTH,
  STAGE_H,
  STAGE_W,
  TRAILS,
  WORD_X,
  WORD_Y,
  introFrame,
} from "../lib/brandIntro";

// Set once the intro has played in this tab, so coming back to the page shows
// the finished logo rather than playing it all again.
const PLAYED_KEY = "rubintv:brand-intro-played";

function alreadyPlayed(): boolean {
  try {
    return sessionStorage.getItem(PLAYED_KEY) !== null;
  } catch {
    return false;
  }
}

function markPlayed() {
  try {
    sessionStorage.setItem(PLAYED_KEY, "1");
  } catch {
    // No storage (private mode, blocked): it just plays again next visit.
  }
}

function reducedMotion(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// The brand lockup: the RubinTV constellation television with the name beside
// it. The first time it's shown in a tab it arrives as an intro — the Rubin
// "shooting stars" mark, whose trails sweep off while its dots and sparkles
// gather into the set — and after that it's simply there. Anyone who asks for
// reduced motion gets the finished logo. Clicking it plays the intro again.
//
// `paused` holds a due intro on its first frame, the Rubin mark, without
// starting it or counting it as played: for a page that may be about to hand
// over to another one that shows the logo too.
export function BrandIntro({ paused = false }: { paused?: boolean }) {
  // `run` counts plays; 0 means none is wanted and the logo stands finished.
  const [run, setRun] = useState(() =>
    reducedMotion() || alreadyPlayed() ? 0 : 1,
  );
  const [t, setT] = useState(run ? 0 : INTRO_END);

  useEffect(() => {
    if (!run || paused) return;
    markPlayed();
    let raf = 0;
    let start: number | null = null;
    const tick = (now: number) => {
      start ??= now;
      const next = Math.min((now - start) / 1000, INTRO_END);
      setT(next);
      if (next < INTRO_END) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [run, paused]);

  const replay = useCallback(() => {
    setT(0);
    setRun((n) => n + 1);
  }, []);

  const frame = introFrame(t);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="brand-intro"
      viewBox={`0 0 ${STAGE_W} ${STAGE_H}`}
      // Intrinsic width/height keep the logo small before index.css applies,
      // so a hard refresh can't flash the SVG at its unconstrained size.
      width="302"
      height="104"
      role="img"
      aria-label="RubinTV"
      onClick={replay}
    >
      {TRAILS.map(
        (trail, i) =>
          frame.trails[i].opacity > 0 && (
            <g
              key={i}
              className="bi-trail"
              opacity={frame.trails[i].opacity}
              transform={`rotate(${frame.trails[i].rotate} ${trail.cx} ${trail.cy})`}
            >
              {trail.d && <path d={trail.d} />}
              {trail.branch && <path className="bi-branch" d={trail.branch} />}
              {trail.dots.map((dot, j) => (
                <circle key={j} cx={dot.cx} cy={dot.cy} r={dot.r} />
              ))}
            </g>
          ),
      )}
      {frame.lines.map(
        (line, i) =>
          line.opacity > 0 && (
            <line
              key={i}
              className="bi-line"
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              strokeWidth={LINE_WIDTH}
            />
          ),
      )}
      {frame.points.map((p, i) => {
        // Rubin's teal in the mark, the app's accent in the television.
        const style = {
          fill: `color-mix(in srgb, var(--accent) ${p.mix}%, var(--accent-bright))`,
        };
        return p.kind === "dot" ? (
          <circle key={i} cx={p.cx} cy={p.cy} r={p.r} opacity={p.opacity} style={style} />
        ) : (
          <path
            key={i}
            d={p.d}
            opacity={p.opacity}
            transform={`rotate(${p.rotate} ${p.cx} ${p.cy})`}
            style={style}
          />
        );
      })}
      <text className="bi-word" x={WORD_X} y={WORD_Y} opacity={frame.wordOpacity}>
        Rubin<tspan className="bi-word-tv">TV</tspan>
      </text>
    </svg>
  );
}
