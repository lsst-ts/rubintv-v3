// Types for the vendored guide timeline (timeline.js, BSD-2 © Josh Meyers).

export interface GuideBlockInput {
  program: string;
  /** UTC ISO-8601. */
  begin: string;
  end: string;
  seq_num_0: number;
  seq_num_1: number;
}

/** A block as the timeline sees it once parsed: dates are Dates and the
 * observing-day row is attached. Spanning parts carry the original. */
export interface GuideBlockDatum extends Omit<GuideBlockInput, "begin" | "end"> {
  begin: Date;
  end: Date;
  day: string;
  blockId: number;
  isSpanningPart: boolean;
  originalBlock: GuideBlockDatum | null;
}

export interface GuideLink {
  label: string;
  href: string;
  /** In-app route: handled through onNavigate instead of a page load. */
  internal?: boolean;
}

export interface RenderGuideOptions {
  blocks: GuideBlockInput[];
  names: Record<string, string>;
  dayStartUtcHour: number;
  links?: (block: GuideBlockDatum, day: string) => GuideLink[];
  onNavigate?: (path: string) => void;
  minBlockMinutes?: number;
  futureMonths?: number;
}

export function renderGuide(
  root: HTMLElement,
  opts: RenderGuideOptions,
): { dispose: () => void };
