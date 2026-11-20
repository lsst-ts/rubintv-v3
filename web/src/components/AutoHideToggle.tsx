import { useAutoHideTopbar } from "../lib/prefs";

// On/off switch, in the NavMenu, for the camera table hiding the topbar while
// it's scrolled down. The setting is a pref (lib/prefs); the table applies it.
export function AutoHideToggle() {
  const [on, setOn] = useAutoHideTopbar();
  return (
    <button
      type="button"
      role="switch"
      className="pref-switch"
      aria-checked={on}
      aria-label="Auto-hide topbar"
      title="Hide this bar while a table is scrolled down, so the table fills the window"
      onClick={() => setOn(!on)}
    >
      <span className="pref-switch-thumb" />
    </button>
  );
}
