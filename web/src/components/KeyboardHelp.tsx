import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../lib/useDismiss";
import { onOpenKeyboardHelp } from "../lib/keyboardHelp";
import {
  GROUPS,
  SHORTCUTS,
  comboKeys,
  pressed,
  shownCombos,
  typingInField,
  type Scope,
} from "../lib/shortcuts";

// The keyboard-shortcuts panel. ? opens and closes it from anywhere but a
// text field, and the NavMenu offers it to anyone who doesn't know to press ?.
// `here` names the scopes the current page answers; their groups come first,
// marked, so the panel leads with what works on this page.
export function KeyboardHelp({ here }: { here: Scope[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => onOpenKeyboardHelp(() => setOpen(true)), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !pressed(e, "help") || typingInField()) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return open ? <Panel here={here} onClose={() => setOpen(false)} /> : null;
}

function Panel({ here, onClose }: { here: Scope[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(true, ref, onClose);
  // Focus moves into the panel, so the page's own keys (the table's
  // scrolling) stand down while it's up, and goes back where it was after.
  useEffect(() => {
    const before = document.activeElement;
    ref.current?.focus();
    return () => {
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);

  const applies = (s: Scope) => here.includes(s);
  const groups = [...GROUPS].sort(
    (a, b) => Number(applies(b.scope)) - Number(applies(a.scope)),
  );

  return createPortal(
    <div className="cell-modal-backdrop">
      <div
        className="cell-modal keys-modal"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keys-title"
        tabIndex={-1}
      >
        <div className="cell-modal-head">
          <span className="cell-modal-title" id="keys-title">
            Keyboard shortcuts
          </span>
          <button
            type="button"
            className="cell-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="keys-body">
          {groups.map((g) => (
            <section key={g.scope} className="keys-group">
              <h3>
                {g.title}
                {g.scope !== "anywhere" && applies(g.scope) && (
                  <span className="keys-here">this page</span>
                )}
              </h3>
              <dl>
                {g.ids.map((id) => (
                  <Fragment key={id}>
                    <dt>
                      {shownCombos(id).map((c, i) => (
                        <Fragment key={i}>
                          {i > 0 && <span className="keys-or">or</span>}
                          {comboKeys(c).map((k) => (
                            <kbd key={k}>{k}</kbd>
                          ))}
                        </Fragment>
                      ))}
                    </dt>
                    <dd>{SHORTCUTS[id].does}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
          <p className="keys-foot">
            Tab and Shift Tab move between controls, and Enter or Space presses
            the one in focus: a day in the date picker, or a column heading to
            sort by it.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
