import type { ReactElement } from "react";
import { useDensity, type Density } from "../lib/prefs";

// Segmented compact / regular control for the table's row density, in the
// NavMenu beside the theme picker (and styled like it). The density itself
// is a pref (lib/prefs); the camera table applies it.

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

// Three slim rows.
function CompactIcon() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="3.5" width="18" height="4.5" rx="1" />
      <rect x="3" y="9.75" width="18" height="4.5" rx="1" />
      <rect x="3" y="16" width="18" height="4.5" rx="1" />
    </svg>
  );
}

// Two roomy ones.
function RegularIcon() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="3.5" width="18" height="7" rx="1.5" />
      <rect x="3" y="13.5" width="18" height="7" rx="1.5" />
    </svg>
  );
}

const OPTIONS: Array<[Density, string, () => ReactElement]> = [
  ["compact", "Compact", CompactIcon],
  ["regular", "Regular", RegularIcon],
];

export function DensityToggle() {
  const [density, setDensity] = useDensity();
  return (
    <div className="theme-seg" role="group" aria-label="Table row density">
      {OPTIONS.map(([val, label, Icon]) => (
        <button
          key={val}
          type="button"
          className={"theme-seg-btn" + (density === val ? " active" : "")}
          title={`${label} rows`}
          aria-label={`${label} rows`}
          aria-pressed={density === val}
          onClick={() => setDensity(val)}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}
