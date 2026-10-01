import { render, screen } from "@testing-library/react";
import { LiveClocks } from "./LiveClocks";

beforeEach(() => {
  vi.useFakeTimers();
  // Fix "now" to a known UTC instant: 2026-05-01T14:01:23Z.
  vi.setSystemTime(Date.UTC(2026, 4, 1, 14, 1, 23));
});
afterEach(() => vi.useRealTimers());

test("UTC clock always shows", () => {
  render(<LiveClocks sinceLabel={null} lastImage={null} />);
  expect(screen.getByText("UTC")).toBeDefined();
  expect(screen.getByText("14:01:23")).toBeDefined();
});

test("time-since clock shows elapsed from Date begin when a label is given", () => {
  // Last image 3m 48s before now → 00:03:48.
  render(
    <LiveClocks
      sinceLabel="Time since last image"
      lastImage="2026-05-01T13:57:35"
    />,
  );
  expect(screen.getByText("Time since last image")).toBeDefined();
  expect(screen.getByText("00:03:48")).toBeDefined();
});

test("no time-since clock without a label", () => {
  render(<LiveClocks sinceLabel={null} lastImage="2026-05-01T13:57:35" />);
  expect(screen.queryByText(/time since/i)).toBeNull();
});

test("no time-since value when Date begin can't be parsed", () => {
  // A bare time with no date can't be anchored; only the UTC clock shows.
  render(<LiveClocks sinceLabel="Time since last image" lastImage="10:12:16" />);
  expect(screen.getByText("UTC")).toBeDefined();
  // The label only renders alongside a computed value.
  expect(screen.queryByText("Time since last image")).toBeNull();
});
