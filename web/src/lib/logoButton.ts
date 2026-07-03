import type { CSSProperties } from "react";
import { logoUrl } from "./basePath";

// The full-bleed logo button (location & camera landing cards). Ported from the
// original RubinTV `logo-button.jinja` + `_buttons.sass`: the logo fills the
// button as a background photo with the title overlaid at the bottom-left.
//
// A photo (jpg) is scaled to `cover` so it fills the button; a vector mark
// (svg) is centred at its natural size instead, matching the original's
// `background-size: cover` exception for `.svg` logos (which are line-art marks,
// not photos, and would look wrong stretched). `text_colour`/`text_shadow` keep
// the title legible over whatever the logo happens to be.
//
// Config entries without a logo get an undefined background so the button falls
// back to its plain themed style (the `.logo-button` CSS default).

interface LogoButtonConfig {
  logo?: string | null;
  text_colour?: string | null;
  text_shadow?: boolean | null;
}

export function logoButtonStyle(cfg: LogoButtonConfig): CSSProperties {
  const url = logoUrl(cfg.logo);
  const isSvg = !!cfg.logo && cfg.logo.toLowerCase().endsWith(".svg");
  return {
    backgroundImage: url ? `url("${url}")` : undefined,
    backgroundSize: url ? (isSvg ? "contain" : "cover") : undefined,
    color: cfg.text_colour ?? undefined,
    textShadow: cfg.text_shadow ? "1px 1px 3px #000" : undefined,
  };
}
