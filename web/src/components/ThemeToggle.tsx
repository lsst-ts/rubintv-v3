import type { ReactElement } from "react";
import { useTheme, type ThemeMode } from "../lib/useTheme";

// Segmented light / system / dark control. Icons ported from the design
// (design/from-claude/Camera Table - Sidebar v2.html). The palette swap itself
// lives in useTheme + index.css; this is just the picker.

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function SunIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </svg>
  );
}

function AutoIcon() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="4" width="18" height="13" rx="1.5" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg {...iconProps}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

const OPTIONS: Array<[ThemeMode, string, () => ReactElement]> = [
  ["light", "Light", SunIcon],
  ["system", "System", AutoIcon],
  ["dark", "Dark", MoonIcon],
];

export function ThemeToggle() {
  const [mode, setMode] = useTheme();
  return (
    <div className="theme-seg" role="group" aria-label="Color theme">
      {OPTIONS.map(([val, label, Icon]) => (
        <button
          key={val}
          type="button"
          className={"theme-seg-btn" + (mode === val ? " active" : "")}
          title={`${label} theme`}
          aria-label={`${label} theme`}
          aria-pressed={mode === val}
          onClick={() => setMode(val)}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}
