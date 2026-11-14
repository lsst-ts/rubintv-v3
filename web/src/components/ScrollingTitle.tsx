// A one-line label that truncates with an ellipsis at rest and, when it is
// truncated, scrolls its full text back and forth while its parent row is
// hovered or holds focus.
//
// The outer span is the clip box (overflow hidden + ellipsis) and the inner
// span carries the text. Two CSS facts force the split: `transform` does
// nothing on a plain inline box, and an inline-block wider than its line is
// swallowed whole by `text-overflow: ellipsis`. So the inner span stays inline
// (ellipsis works) until the row is hovered, then becomes an inline-block with
// the ellipsis switched to clip and slides by translateX — see .scrolling-title
// in index.css.
//
// The overflow is measured here and written straight onto the DOM node
// (data-overflow plus three custom properties) rather than into state, so a
// resize re-measures without re-rendering the picker.

import { useLayoutEffect, useRef, type ReactNode } from "react"

// Scroll speed in px/s, so long and short names travel at the same pace.
const SPEED = 80
// Shortest travel in seconds, so a few-pixel overflow glides, not twitches.
const MIN_TRAVEL = 0.3
// Pauses in seconds, fixed whatever the distance: before moving, and at the
// end showing the tail. The animation alternates (each pass plays forward then
// backward), so between passes each pause is seen twice over; only the very
// first START_HOLD is single.
const START_HOLD = 0.25
const END_HOLD = 0.5
// Points sampled along the ease-in-out curve in the generated easing.
const EASE_STEPS = 8

// One pass as a CSS linear() easing: flat through the start hold, a sampled
// ease-in-out across the travel, flat through the end hold. Keyframe
// percentages can't take var(), so per-label pauses have to live in the easing.
function passEasing(travel: number, total: number): string {
  const at = (t: number) => `${((t / total) * 100).toFixed(2)}%`
  const stops = ["0", `0 ${at(START_HOLD)}`]
  for (let i = 1; i < EASE_STEPS; i++) {
    const f = i / EASE_STEPS
    const eased = (1 - Math.cos(Math.PI * f)) / 2
    stops.push(`${eased.toFixed(3)} ${at(START_HOLD + travel * f)}`)
  }
  stops.push(`1 ${at(START_HOLD + travel)}`, "1")
  return `linear(${stops.join(", ")})`
}

interface Props {
  children: ReactNode
  className?: string
  title?: string
}

export function ScrollingTitle({ children, className, title }: Props) {
  const ref = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    const text = textRef.current
    if (!el || !text) return
    const measure = () => {
      // Compare unrounded widths: the browser draws the ellipsis for any
      // overflow, even a fraction of a pixel, while scrollWidth/clientWidth
      // round to whole pixels and miss it — leaving a label that looks
      // truncated but never scrolls. The text span is inline at rest, so its
      // box is the full text width (the ellipsis is paint-only); the clip box
      // has no padding, so its box is the space the text gets.
      const distance =
        text.getBoundingClientRect().width - el.getBoundingClientRect().width
      if (distance > 0) {
        const travel = Math.max(distance / SPEED, MIN_TRAVEL)
        const total = START_HOLD + travel + END_HOLD
        el.dataset.overflow = ""
        el.style.setProperty("--scroll-by", `${-distance}px`)
        el.style.setProperty("--scroll-time", `${total.toFixed(3)}s`)
        el.style.setProperty("--scroll-ease", passEasing(travel, total))
      } else {
        delete el.dataset.overflow
      }
    }
    // Fires once on observe (the popover opening un-hides it) and again
    // whenever the picker's width changes.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [children])

  return (
    <span
      ref={ref}
      className={className ? `scrolling-title ${className}` : "scrolling-title"}
      title={title}
    >
      <span ref={textRef} className="scrolling-title-text">
        {children}
      </span>
    </span>
  )
}
