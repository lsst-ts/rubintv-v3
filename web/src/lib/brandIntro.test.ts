import { INTRO_END, TRAILS, introFrame } from "./brandIntro";

// The brand intro is a pure function of time, so each test asks for a frame
// and looks at it: no clock, no rendering.

test("the Rubin mark's trails are traced once, up front", () => {
  expect(TRAILS).toHaveLength(7);
  // A branched trail: its arc, the branch's centre line, and three dots (the
  // tail's cap, the head's dot, the branch's dot).
  expect(TRAILS[0].d.startsWith("M")).toBe(true);
  expect(TRAILS[0].branch).toBe("M396 25.5L405.5 55L437 72");
  expect(TRAILS[0].dots).toHaveLength(3);
  // The dot with no trail of its own.
  expect(TRAILS[1].d).toBe("");
  expect(TRAILS[1].dots).toEqual([{ cx: 490, cy: 96, r: 9.6 }]);
  // A plain trail ends in its dot, or, with none, in a cap half its width.
  expect(TRAILS[3].branch).toBe("");
  expect(TRAILS[3].dots[1].r).toBe(9.3);
  expect(TRAILS[5].dots[1].r).toBe(4);
});

test("the first frame is the Rubin mark, untouched", () => {
  const f = introFrame(0);
  for (const trail of f.trails) expect(trail).toEqual({ rotate: 0, opacity: 1 });
  // Its dots and sparkles sit where the mark has them, in the mark's colour.
  expect(f.points[0]).toMatchObject({
    kind: "dot", cx: 94, cy: 109.5, r: 11.8, opacity: 1, mix: 0,
  });
  expect(f.points[4]).toMatchObject({
    kind: "star", cx: 30.5, cy: 130.5, r: 29.5, rotate: 0, mix: 0,
  });
  // A sparkle's outline starts at its right-hand tip.
  expect(f.points[4].d.startsWith("M60.00 130.50L")).toBe(true);
  // The points the mark doesn't have aren't there yet, nor the outline or
  // the name.
  for (const p of f.points.slice(5)) {
    expect(p.opacity).toBe(0);
    expect(p.r).toBeCloseTo(0);
  }
  expect(f.lines.every((line) => line.opacity === 0)).toBe(true);
  expect(f.wordOpacity).toBe(0);
});

test("the last frame is the television with its name", () => {
  const f = introFrame(INTRO_END);
  // The trails have swept round and gone.
  for (const trail of f.trails) expect(trail).toEqual({ rotate: 34, opacity: 0 });
  // Every point is in place, in the television's colour.
  expect(f.points[0]).toMatchObject({ kind: "dot", cx: 13, cy: 74, mix: 100 });
  expect(f.points[0].r).toBeCloseTo(10.2);
  for (const p of f.points) expect(p).toMatchObject({ opacity: 1, mix: 100 });
  // The sparkles that spun on the way have landed upright: a four-point star
  // looks the same every quarter turn.
  expect(f.points[2].rotate).toBe(540);
  expect(f.points[4].rotate).toBe(270);
  expect(f.points[4].d.startsWith("M115.00 122.00L")).toBe(true);
  // The outline is drawn in full: the first section runs from the top-left
  // corner to the antenna base.
  expect(f.lines).toHaveLength(7);
  expect(f.lines.every((line) => line.opacity === 1)).toBe(true);
  expect(f.lines[0]).toMatchObject({ x1: 13, y1: 74, x2: 76 });
  expect(f.lines[0].y2).toBeCloseTo(71.3);
  expect(f.wordOpacity).toBe(1);
});

test("a point swings into place rather than going straight there", () => {
  // Halfway through the top-left corner's journey (it sets off at 0.2 s and
  // takes 1.4 s).
  const p = introFrame(0.9).points[0];
  expect(p.mix).toBe(50);
  expect(p.cx).toBeCloseTo(49.6, 1);
  // The straight line's midpoint is at y = 91.75; the path bows below it.
  expect(p.cy).toBeCloseTo(100.7, 1);
  expect(p.r).toBeCloseTo(11);
});

test("a sparkle spins as it travels", () => {
  // Halfway through the small sparkle's journey: half of its turn and a half.
  expect(introFrame(1.1).points[2].rotate).toBeCloseTo(270);
});

test("a point the Rubin mark doesn't have pops in a little oversized", () => {
  // The top-right corner starts to appear at 1.4 s.
  const p = introFrame(1.6).points[5];
  expect(p.opacity).toBe(1);
  expect(p.r).toBeGreaterThan(10.2);
  expect(introFrame(INTRO_END).points[5].r).toBeCloseTo(10.2);
});

test("a line starts only once the point it grows from has arrived", () => {
  // The top-left corner lands at 1.6 s; nothing is drawn before that.
  expect(introFrame(1.6).lines.every((line) => line.opacity === 0)).toBe(true);
  const f = introFrame(1.9);
  // Its line is on the way to the antenna base…
  expect(f.lines[0].opacity).toBe(1);
  expect(f.lines[0].x2).toBeGreaterThan(13);
  expect(f.lines[0].x2).toBeLessThan(76);
  // …whose own lines wait for it to get there.
  expect(f.lines[1].opacity).toBe(0);
  expect(f.lines[5].opacity).toBe(0);
});
