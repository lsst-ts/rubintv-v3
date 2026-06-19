import { useState } from "react";
import { CopyIcon } from "./Icons";

// A small button that copies a given string to the clipboard and briefly
// confirms. Used for per-row "copy row" (a filled copy_row_template, e.g. a
// dataId string). Mirrors ShareLink's quiet-on-failure clipboard handling:
// clipboard access can be blocked (insecure context / permissions), so we
// swallow the error rather than throwing.
//
// `icon` renders just the copy glyph (label kept as the accessible name) — used
// in the dense camera table; the default text mode is used elsewhere.
export function CopyButton({
  text,
  label = "Copy row",
  title,
  icon = false,
}: {
  text: string;
  label?: string;
  title?: string;
  icon?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked; leave the button quiet.
    }
  };

  if (icon) {
    // Accessible name is the label; the tooltip shows what will be copied
    // (the filled template) so a hover still reveals it, as in text mode.
    return (
      <button
        type="button"
        className={"copy-row action-link" + (copied ? " copied" : "")}
        onClick={onClick}
        aria-label={label}
        title={copied ? "Copied!" : (title ?? text)}
      >
        <CopyIcon />
      </button>
    );
  }

  return (
    <button
      type="button"
      className="copy-row"
      onClick={onClick}
      title={title ?? text}
    >
      {copied ? "Copied!" : label}
    </button>
  );
}
