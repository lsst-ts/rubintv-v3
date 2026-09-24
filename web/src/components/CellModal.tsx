import { useRef } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../lib/useDismiss";

// Modal showing a metadata cell's key/value pairs. Some metadata values are
// JSON objects (or arrays) rather than scalars; the table renders a small
// foldout button for them and opens this dialog on click. Mirrors the old
// app's cell-dict modal: a table of every entry, with the DISPLAY_VALUE key
// (used only as the button label) omitted from the body.
//
// Dismisses on outside click or Escape (shared useDismiss), and is rendered
// through a portal so the fixed overlay isn't clipped by the scrolling table.
export function CellModal({
  header,
  data,
  onClose,
}: {
  header: string;
  data: Record<string, unknown> | unknown[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(true, ref, onClose);

  const entries = Array.isArray(data)
    ? data.map((v, i) => [String(i), v] as const)
    : Object.entries(data).filter(([k]) => k !== "DISPLAY_VALUE");

  return createPortal(
    <div className="cell-modal-backdrop">
      <div className="cell-modal" ref={ref} role="dialog" aria-modal="true">
        <div className="cell-modal-head">
          <span className="cell-modal-title">{header}</span>
          <button
            type="button"
            className="cell-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <table className="cell-dict">
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key}>
                <th className="key">{key}</th>
                <td className="value">
                  {value === null || typeof value === "object"
                    ? JSON.stringify(value)
                    : String(value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>,
    document.body,
  );
}
