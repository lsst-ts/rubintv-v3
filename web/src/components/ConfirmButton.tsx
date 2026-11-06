import { useState } from "react";

// A button that requires a second click to confirm before firing — used for
// destructive admin actions (flush cache, flush redis, reset head node). The
// confirm step is inline (no modal) so it works in any context and is easy to
// test; the button text changes to a "Confirm" prompt and reverts on cancel or
// after a short timeout.
export function ConfirmButton({
  label,
  confirmLabel = "Confirm?",
  onConfirm,
  danger = false,
  disabled = false,
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  danger?: boolean;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const fire = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  if (armed) {
    const cancel = () => setArmed(false);
    return (
      <span
        className="confirm-group"
        // Esc cancels the pending confirm (ignored while the action is firing).
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) {
            e.stopPropagation();
            cancel();
          }
        }}
      >
        <button
          type="button"
          className={danger ? "confirm-yes danger" : "confirm-yes"}
          onClick={fire}
          disabled={busy}
          // Focus the confirm on arm so Esc reaches this group's handler.
          autoFocus
        >
          {busy ? "Working…" : confirmLabel}
        </button>
        <button
          type="button"
          className="confirm-no"
          onClick={cancel}
          disabled={busy}
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      className={danger ? "danger" : ""}
      onClick={() => setArmed(true)}
      disabled={disabled}
    >
      {label}
    </button>
  );
}
