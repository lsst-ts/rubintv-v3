import { useState } from "react";

// A small button that copies a given string to the clipboard and briefly
// confirms. Used for per-row "copy row" (a filled copy_row_template, e.g. a
// dataId string). Mirrors ShareLink's quiet-on-failure clipboard handling:
// clipboard access can be blocked (insecure context / permissions), so we
// swallow the error rather than throwing.
export function CopyButton({
  text,
  label = "Copy row",
  title,
}: {
  text: string;
  label?: string;
  title?: string;
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
