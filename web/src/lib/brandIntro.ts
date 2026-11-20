// Geometry and timing for the brand intro: the Rubin "shooting stars" mark
// turning into the RubinTV constellation television, with the name fading in
// beside it. Everything here is a pure function of the time t (seconds), so
// the component only has to run a clock and a test can ask for any frame.
//
// Coordinates are the Rubin mark's own 502 x 189 box (traced from
// public/rubin-mark.png). The television is the 64-unit logo scaled by K and
// shifted by (TX, TY), which stands it at the left of the stage at the mark's
// full height; the name takes the room the trails leave behind.

export const INTRO_END = 3.5;
export const STAGE_W = 548;
export const STAGE_H = 189;
// Where the name sits: its left edge and its baseline.
export const WORD_X = 194;
export const WORD_Y = 127;

const K = 3;
const TX = -14;
const TY = 2;

type XY = [number, number];

const tv = (x: number, y: number): XY => [TX + K * x, TY + K * y];
const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, m: number) => a + (b - a) * m;
const smooth = (u: number) => u * u * (3 - 2 * u);
const inOutCubic = (u: number) =>
  u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
const inOutQuad = (u: number) =>
  u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
// Overshoots a little before settling: the pop of a point appearing.
const outBack = (u: number) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2);
};
const fix = (n: number) => n.toFixed(2);

// ── Trails ──────────────────────────────────────────────────────────────
// Each trail of the Rubin mark is an arc of a circle (centre c, radius r)
// tapering from w0 at its tail to w1 at its head, some with a dot on the
// head and a kinked branch ending in a second dot. One is a dot on its own,
// which still has a centre to turn about.
interface ArcSpec {
  c: XY;
  r: number;
  from: XY;
  to: XY;
  w0: number;
  w1: number;
  dot?: number;
  branch?: { path: XY[]; dot: number };
}
interface LoneDotSpec {
  c: XY;
  at: XY;
  dot: number;
}

// Rightmost first: the order they set off in.
const ARCS: (ArcSpec | LoneDotSpec)[] = [
  {
    c: [278.7, 349.9], r: 347.0, from: [309, 4], to: [472, 62],
    w0: 8, w1: 8, dot: 9.5,
    branch: { path: [[396, 25.5], [405.5, 55], [437, 72]], dot: 9.5 },
  },
  { c: [282, 345], at: [490, 96], dot: 9.6 },
  {
    c: [279.5, 356.8], r: 277.8, from: [360, 91], to: [490.5, 176],
    w0: 8, w1: 8, dot: 9.5,
    branch: { path: [[432.5, 121], [455.5, 114.5], [490, 144]], dot: 9.4 },
  },
  { c: [285, 327.8], r: 280.3, from: [226, 53], to: [369, 60], w0: 4, w1: 8, dot: 9.3 },
  { c: [284.1, 348.8], r: 240.2, from: [191, 128], to: [339, 115], w0: 4, w1: 8, dot: 9.4 },
  { c: [285.2, 336.3], r: 332.9, from: [113, 51], to: [258, 5], w0: 2, w1: 8 },
  { c: [290.5, 357.4], r: 288.7, from: [105, 136], to: [217, 78], w0: 2, w1: 7.2 },
];

export interface Trail {
  // The tapered arc's outline; empty for the lone dot.
  d: string;
  // The branch's centre line (stroked, not filled); empty when there is none.
  branch: string;
  dots: { cx: number; cy: number; r: number }[];
  // The centre the trail turns about, and when it sets off.
  cx: number;
  cy: number;
  t0: number;
}

function buildTrail(a: ArcSpec | LoneDotSpec, i: number): Trail {
  const trail: Trail = {
    d: "", branch: "", dots: [], cx: a.c[0], cy: a.c[1], t0: i * 0.05,
  };
  if ("at" in a) {
    trail.dots.push({ cx: a.at[0], cy: a.at[1], r: a.dot });
    return trail;
  }
  const { r, w0, w1 } = a;
  const a0 = Math.atan2(a.from[1] - a.c[1], a.from[0] - a.c[0]);
  const a1 = Math.atan2(a.to[1] - a.c[1], a.to[0] - a.c[0]);
  const n = 48;
  const outer: string[] = [];
  const inner: string[] = [];
  for (let j = 0; j <= n; j++) {
    const u = j / n;
    const ang = lerp(a0, a1, u);
    const w = lerp(w0, w1, u) / 2;
    const cs = Math.cos(ang);
    const sn = Math.sin(ang);
    outer.push(`${fix(a.c[0] + (r + w) * cs)} ${fix(a.c[1] + (r + w) * sn)}`);
    inner.unshift(`${fix(a.c[0] + (r - w) * cs)} ${fix(a.c[1] + (r - w) * sn)}`);
  }
  trail.d = "M" + outer.concat(inner).join("L") + "Z";
  // Round both ends; the head's cap is the dot where the trail has one.
  trail.dots.push(
    { cx: a.c[0] + r * Math.cos(a0), cy: a.c[1] + r * Math.sin(a0), r: w0 / 2 },
    { cx: a.c[0] + r * Math.cos(a1), cy: a.c[1] + r * Math.sin(a1), r: a.dot ?? w1 / 2 },
  );
  if (a.branch) {
    trail.branch = "M" + a.branch.path.map((p) => p.join(" ")).join("L");
    const end = a.branch.path[a.branch.path.length - 1];
    trail.dots.push({ cx: end[0], cy: end[1], r: a.branch.dot });
  }
  return trail;
}

export const TRAILS: Trail[] = ARCS.map(buildTrail);

// How long a trail takes to leave, and how far round its circle it gets.
const TRAIL_DUR = 1.1;
const TRAIL_SWEEP = 34;

// ── Points ──────────────────────────────────────────────────────────────
// "from" is a shape in the Rubin mark (x, y, radius and, for a sparkle, the
// offset of its inner corners); "to" is its place in the television, in the
// logo's 64-unit coordinates. A point with no "from" isn't in the Rubin mark
// and appears on the spot. "turns" is how often a sparkle spins, clockwise,
// on its way: a multiple of a quarter, so it lands upright.
interface PointSpec {
  kind: "dot" | "star";
  from?: [number, number, number, number?];
  to: [number, number, number];
  turns?: number;
}

const POINT_SPECS: PointSpec[] = [
  { kind: "dot", from: [94, 109.5, 11.8], to: [9, 24, 3.4] }, // top-left corner
  { kind: "dot", from: [66.5, 167.5, 10.8], to: [11, 58, 3.4] }, // bottom-left
  { kind: "star", from: [121, 162, 20.5, 6], to: [17, 7, 6], turns: 1.5 }, // left antenna tip
  { kind: "dot", from: [68, 85, 7.6], to: [45, 31, 1.6] }, // the star on screen
  { kind: "star", from: [30.5, 130.5, 29.5, 6.5], to: [33, 40, 10], turns: 0.75 }, // the picture
  { kind: "dot", to: [54, 22, 3.4] }, // top-right corner
  { kind: "dot", to: [56, 56, 3.4] }, // bottom-right corner
  { kind: "dot", to: [30, 23.1, 2.6] }, // antenna base
  { kind: "star", to: [46, 7, 6] }, // right antenna tip
];

const MOVE_DUR = 1.4;
const POP_DUR = 0.5;
// When each point that isn't in the Rubin mark starts to appear, in the order
// above: the right-hand corners early enough to be solid before their lines
// start, then the antenna base, then the second sparkle.
const POP_T0 = [1.4, 1.46, 1.73, 1.87];

interface Mover {
  spec: PointSpec;
  t0: number;
  to: XY;
  toR: number;
  // Only for a point that travels: where from, the control point of the
  // gently bowed path it takes, its starting radius and, for a sparkle, how
  // far out its inner corners start (as a fraction of that radius).
  travel?: { from: XY; ctrl: XY; r: number; q: number };
}

let moved = 0;
let popped = 0;
const MOVERS: Mover[] = POINT_SPECS.map((spec) => {
  const to = tv(spec.to[0], spec.to[1]);
  const toR = spec.to[2] * K;
  if (!spec.from) {
    return { spec, t0: POP_T0[popped++], to, toR };
  }
  const [fx, fy, fr, corner] = spec.from;
  const dx = to[0] - fx;
  const dy = to[1] - fy;
  return {
    spec,
    t0: 0.2 + moved++ * 0.1,
    to,
    toR,
    travel: {
      from: [fx, fy],
      // Bowed to the left of the direction of travel, so the points swing
      // clockwise into place as the trails do on their way out.
      ctrl: [(fx + to[0]) / 2 + 0.22 * dy, (fy + to[1]) / 2 - 0.22 * dx],
      r: fr,
      q: corner !== undefined ? corner / fr : 0,
    },
  };
});

// A four-point sparkle. m = 0 is the Rubin mark's straight-sided star, whose
// inner corners sit at (q, q) of its radius; m = 1 is the television's
// concave one. Both are sampled at the same steps so they blend point for
// point.
function starPath(x: number, y: number, r: number, q: number, m: number): string {
  const n = 14;
  const pts: string[] = [];
  for (let k = 0; k < 4; k++) {
    for (let j = 0; j < n; j++) {
      const u = j / n;
      const sx = u < 0.5 ? lerp(1, q, 2 * u) : lerp(q, 0, 2 * u - 1);
      const sy = u < 0.5 ? lerp(0, q, 2 * u) : lerp(q, 1, 2 * u - 1);
      let px = lerp(sx, (1 - u) * (1 - u), m);
      let py = lerp(sy, u * u, m);
      // Quarter-turn the first arm round to arm k.
      for (let turn = 0; turn < k; turn++) [px, py] = [-py, px];
      pts.push(`${fix(x + r * px)} ${fix(y + r * py)}`);
    }
  }
  return "M" + pts.join("L") + "Z";
}

// ── Lines ───────────────────────────────────────────────────────────────
// Each section of the outline grows from its first point to its second:
// clockwise round the screen, then out from the antenna base to each tip. The
// third entry is when it starts. A line spends its first 0.2 s or so hidden
// under its own point, so the four corner lines show at about 1.8 s and the
// antenna base's at about 2.2 s, as the line from the top-left reaches it.
const P1 = tv(9, 24);
const P2 = tv(54, 22);
const P3 = tv(56, 56);
const P4 = tv(11, 58);
const P5 = tv(30, 23.1);
const T1 = tv(17, 7);
const T2 = tv(46, 7);
const LINE_SPECS: [XY, XY, number][] = [
  [P1, P5, 1.6],
  [P5, P2, 2.0],
  [P2, P3, 1.6],
  [P3, P4, 1.66],
  [P4, P1, 1.7],
  [P5, T1, 2.0],
  [P5, T2, 2.0],
];
const LINE_DUR = 0.75;
export const LINE_WIDTH = 2.4 * K;

// The name fades in as the last lines land.
const WORD_T0 = 2.6;
const WORD_DUR = 0.6;

// ── A frame ─────────────────────────────────────────────────────────────
export interface PointFrame {
  kind: "dot" | "star";
  cx: number;
  cy: number;
  r: number;
  // A sparkle's outline, already placed at (cx, cy); empty for a dot.
  d: string;
  // Degrees clockwise about (cx, cy).
  rotate: number;
  opacity: number;
  // 0 is the Rubin mark's colour, 100 the television's.
  mix: number;
}

export interface IntroFrame {
  // One per TRAILS entry.
  trails: { rotate: number; opacity: number }[];
  points: PointFrame[];
  lines: { x1: number; y1: number; x2: number; y2: number; opacity: number }[];
  wordOpacity: number;
}

export function introFrame(t: number): IntroFrame {
  const trails = TRAILS.map((trail) => {
    const u = clamp((t - trail.t0) / TRAIL_DUR);
    return {
      rotate: TRAIL_SWEEP * Math.pow(u, 1.8),
      opacity: 1 - smooth(clamp((u - 0.2) / 0.7)),
    };
  });

  const points = MOVERS.map((p): PointFrame => {
    let [cx, cy] = p.to;
    let r = p.toR;
    let m = 1;
    let opacity = 1;
    if (p.travel) {
      const { from, ctrl } = p.travel;
      m = inOutCubic(clamp((t - p.t0) / MOVE_DUR));
      const w = 1 - m;
      cx = w * w * from[0] + 2 * m * w * ctrl[0] + m * m * p.to[0];
      cy = w * w * from[1] + 2 * m * w * ctrl[1] + m * m * p.to[1];
      r = lerp(p.travel.r, p.toR, m);
    } else {
      const u = clamp((t - p.t0) / POP_DUR);
      r = Math.max(0, p.toR * outBack(u));
      opacity = clamp(u * 3);
    }
    return {
      kind: p.spec.kind,
      cx,
      cy,
      r,
      d: p.spec.kind === "star" ? starPath(cx, cy, r, p.travel?.q ?? 0, m) : "",
      rotate: 360 * (p.spec.turns ?? 0) * m,
      opacity,
      mix: Math.round(m * 100),
    };
  });

  const lines = LINE_SPECS.map(([a, b, t0]) => {
    const p = inOutQuad(clamp((t - t0) / LINE_DUR));
    return {
      x1: a[0],
      y1: a[1],
      x2: lerp(a[0], b[0], p),
      y2: lerp(a[1], b[1], p),
      opacity: p > 0 ? 1 : 0,
    };
  });

  return {
    trails,
    points,
    lines,
    wordOpacity: smooth(clamp((t - WORD_T0) / WORD_DUR)),
  };
}
