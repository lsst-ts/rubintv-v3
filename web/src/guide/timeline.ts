/*
 * RubinTV Guide timeline — observing blocks per night, with twilight and
 * moon overlays, search, and keyboard navigation.
 *
 * Ported from https://github.com/jmeyers314/rubintv_guide (main.js).
 *
 * BSD 2-Clause License
 * Copyright (c) 2025, Josh Meyers
 * See web/THIRD_PARTY_NOTICES.md for the full licence text.
 *
 * Changes from the original are confined to how it is hosted: it is a
 * TypeScript module the Guide view mounts into a root element (no global
 * ids, no window globals, disposable listeners), the data arrives as
 * arguments instead of being fetched, the day boundary is the observatory's
 * day_obs rollover rather than Chilean noon, block links come from the
 * caller, and scrolling targets the app's scroll container. The chart
 * itself — layout, colours, twilight and moon calculation, selection,
 * search and keyboard behaviour — is the original's.
 */

import * as d3 from "d3";
import * as Astronomy from "astronomy-engine";

// Cerro Pachón coordinates (Rubin Observatory)
const CERRO_PACHON_LAT = -30.2408;
const CERRO_PACHON_LON = -70.7364;
const CERRO_PACHON_ELEVATION = 2715; // meters

const HOUR_MS = 3600000;

export interface GuideBlockInput {
    program: string;
    /** UTC ISO-8601. */
    begin: string;
    end: string;
    seq_num_0: number;
    seq_num_1: number;
    /** YYYYMMDD of the first / last exposure; present on API blocks. */
    day_obs?: number;
    day_obs_end?: number;
    /** For a block over the day_obs rollover, where seq numbers restart:
     *  its seq range on each night in turn. Absent or empty otherwise. */
    nights?: { day_obs: number; seq_num_0: number; seq_num_1: number }[];
}

/** A block's seq range on one of the nights (YYYY-MM-DD) it covers. */
export interface GuideNight {
    day: string;
    seq_num_0: number;
    seq_num_1: number;
}

/** A block as the timeline sees it once parsed: dates are Dates and the
 * observing-day row is attached. Spanning parts carry the whole block. */
export interface GuideBlockDatum extends Omit<GuideBlockInput, "begin" | "end"> {
    begin: Date;
    end: Date;
    day: string;
    /** Hours since the row's day boundary. */
    x0: number;
    x1: number;
    /** Of the whole block, on spanning parts too. */
    durationH: number;
    blockId: number;
    isSpanningPart: boolean;
    originalBlock: GuideBlockDatum | null;
}

/** An external link for a block; opened in a new tab. */
export interface GuideLink {
    label: string;
    href: string;
}

// Every link in the info panel opens in a new tab, so the guide stays where
// it was. `dayHref` and `rangeHref` are therefore full URL paths (with the
// app's prefix), not router routes.
export interface RenderGuideOptions {
    blocks: GuideBlockInput[];
    /** Program key → description. */
    names: Record<string, string>;
    /** Program key → the program it belongs with: known typos (BLOCK-487 →
     *  BLOCK-T487) and test executions recorded as the program (BLOCK-E8024
     *  → the BLOCK-T382 it ran). */
    aliases?: Record<string, string>;
    /** UTC hour a day_obs row begins at. */
    dayStartUtcHour: number;
    links?: (block: GuideBlockDatum, day: string) => GuideLink[];
    /** Link for a block's observing day; null/absent leaves it as text. */
    dayHref?: (day: string) => string | null;
    /** Link for a block's seq range on one night; null/absent leaves it
     *  as text. */
    rangeHref?: (block: GuideBlockDatum, night: GuideNight) => string | null;
    /** Hide blocks shorter than this (default 5). */
    minBlockMinutes?: number;
    /** Empty rows to draw past the last block (default 6). */
    futureMonths?: number;
}

type Direction = "up" | "down" | "left" | "right";

type SkyState = "day" | "civil" | "nautical" | "astronomical" | "night";

interface TwilightEvent {
    type: string;
    time: Date;
    hours: number;
    minutes: number;
}

interface SkyBackground {
    start: number;
    end: number;
    type: SkyState;
    color: string;
    opacity: number;
}

interface MoonEvent {
    time: Date;
    hours: number;
    minutes: number;
}

interface FuzzyMatch {
    score: number;
    matched: boolean;
}

interface SearchResult extends FuzzyMatch {
    program: string;
    description: string;
    matchingVersions: string[];
}

/**
 * Render the timeline into `root`, the element containing the `.guide-*`
 * hooks. `dispose` removes the chart and every listener it added.
 */
export function renderGuide(root: HTMLElement, opts: RenderGuideOptions): { dispose: () => void } {
    const {
        names: tblockNames,
        aliases = {},
        dayStartUtcHour: DAY_START,
        links,
        dayHref,
        rangeHref,
        minBlockMinutes = 5,
        futureMonths = 6,
    } = opts;
    const rootSel = d3.select(root);
    const disposers: Array<() => void> = [];

    // Parse date strings to Date objects (copies: the caller's data is
    // react-query state and must not be mutated).
    let blocks = opts.blocks.map(d => ({
        ...d,
        begin: new Date(d.begin),
        end: new Date(d.end),
    }));

    // Filter out short blocks (5 minutes in the original)
    blocks = blocks.filter(d => (d.end.getTime() - d.begin.getTime()) >= minBlockMinutes * 60000);

    // Helper function to get the base block name (without version suffix)
    function getBaseBlockName(program: string): string {
        // Some programs are recorded with an underscore or a stray lower-case
        // letter in the prefix (BLOCK_T339_g, BLOCk-539), or with no prefix
        // (T525, E13304); read them as BLOCK-T339_g, BLOCK-539, BLOCK-T525
        // and BLOCK-E13304. Otherwise the suffix rule below cuts the first
        // down to a catch-all "BLOCK", and the names and aliases, keyed by
        // the full form, miss the others.
        const normalised = program
            .replace(/^block[-_]([te]?)(?=\d)/i, (_, l: string) => `BLOCK-${l.toUpperCase()}`)
            .replace(/^([te])(?=\d+(?:_|$))/i, (_, l: string) => `BLOCK-${l.toUpperCase()}`);
        // Remove version suffixes like _v3, _v2, _1, _2, _hexapods, etc.
        // This handles both numeric versions (_v3, _1, _2) and descriptive versions (_hexapods)
        const base = normalised.replace(/_(?:v)?\d+$|_[a-zA-Z][a-zA-Z0-9_]*$/, '');
        // A known typo (BLOCK-487) or a test execution recorded as the
        // program (BLOCK-E8024) belongs with the test case it names or ran.
        return Object.hasOwn(aliases, base) ? aliases[base] : base;
    }

    // Helper function to get description for a program. BLOCK-T123 is named
    // by its Zephyr test case and BLOCK-123 by its Jira issue: different
    // blocks despite the similar numbers (a slip when the data were taken),
    // so neither is given the other's name; the few BLOCK-123 that are a
    // mistyped BLOCK-T123 come aliased to it.
    function getDescription(program: string): string | undefined {
        const base = getBaseBlockName(program);
        return Object.hasOwn(tblockNames, base) ? tblockNames[base] : undefined;
    }

    // Formatting helpers
    const fmtDate = d3.utcFormat("%Y-%m-%d"); // Use UTC formatting for dates too
    const fmtTime = d3.utcFormat("%H:%M"); // Use UTC formatting to match the astronomical convention

    // Observing-day functions - the day runs from DAY_START UTC to DAY_START UTC
    // the next calendar day (noon UTC for day_obs, matching the rest of RubinTV).
    function dayNoon(dayStr: string): Date {
        const [year, month, day] = dayStr.split('-').map(Number);
        return new Date(Date.UTC(year, month - 1, day, DAY_START, 0, 0));
    }

    function getAstronomicalDay(date: Date): string {
        // If time is before the boundary, the observing day started at yesterday's boundary
        const currentDate = new Date(date);
        const currentHour = currentDate.getUTCHours();

        if (currentHour < DAY_START) {
            const yesterday = new Date(currentDate);
            yesterday.setUTCDate(yesterday.getUTCDate() - 1);
            return fmtDate(yesterday);
        } else {
            return fmtDate(currentDate);
        }
    }

    // Preprocess Data - handle blocks that span across observing-day boundaries
    const data: GuideBlockDatum[] = [];

    blocks.forEach((d, blockIndex) => {
        const startDay = getAstronomicalDay(d.begin);
        const endDay = getAstronomicalDay(d.end);
        const startDayNoon = dayNoon(startDay);

        // Calculate positions relative to the start day's boundary
        const x0 = (d.begin.getTime() - startDayNoon.getTime()) / HOUR_MS;
        const x1 = (d.end.getTime() - startDayNoon.getTime()) / HOUR_MS;
        const durationH = (d.end.getTime() - d.begin.getTime()) / HOUR_MS;

        // The whole block on its starting day. Spanning parts point back to
        // this rather than to the bare parsed block (as the original did),
        // so the program summary can list a spanning block with its day and id.
        const whole: GuideBlockDatum = { ...d, day: startDay, x0, x1, durationH, originalBlock: null, isSpanningPart: false, blockId: blockIndex };

        if (startDay === endDay) {
            // Block doesn't span days, add as-is
            data.push(whole);
        } else {
            // Block spans across days - create entries for each day it touches
            const spanDays: string[] = [];
            const currentDate = dayNoon(startDay);
            const endDate = dayNoon(endDay);

            while (currentDate <= endDate) {
                spanDays.push(fmtDate(currentDate));
                currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            }

            spanDays.forEach((dayStr, dayIndex) => {
                const noon = dayNoon(dayStr);

                if (dayIndex === 0) {
                    // First day: from start time to end of observing day
                    data.push({
                        ...d,
                        day: dayStr,
                        x0: (d.begin.getTime() - noon.getTime()) / HOUR_MS,
                        x1: 24,
                        durationH: durationH, // Keep original duration for info display
                        originalBlock: whole,
                        isSpanningPart: true,
                        blockId: blockIndex
                    });
                } else if (dayIndex === spanDays.length - 1) {
                    // Last day: from start of observing day to actual end time
                    data.push({
                        ...d,
                        day: dayStr,
                        x0: 0,
                        x1: (d.end.getTime() - noon.getTime()) / HOUR_MS,
                        durationH: durationH,
                        originalBlock: whole,
                        isSpanningPart: true,
                        blockId: blockIndex
                    });
                } else {
                    // Middle day: entire observing day
                    data.push({
                        ...d,
                        day: dayStr,
                        x0: 0,
                        x1: 24,
                        durationH: durationH,
                        originalBlock: whole,
                        isSpanningPart: true,
                        blockId: blockIndex
                    });
                }
            });
        }
    });

    const chartContainer = rootSel.select<HTMLDivElement>(".guide-chart");
    chartContainer.selectAll("*").remove();

    if (data.length === 0) {
        chartContainer.append("p").attr("class", "guide-empty").text("No observing blocks yet.");
        return { dispose() {} };
    }

    // Generate complete list of days (including empty days and future months)
    const observedDays = Array.from(new Set(data.map(d => d.day))).sort(d3.ascending);

    // Find the date range
    const firstDay = new Date(observedDays[0]);
    const lastObservedDay = new Date(observedDays[observedDays.length - 1]);

    // Extend the end date for future planning
    const lastDay = new Date(lastObservedDay);
    lastDay.setUTCMonth(lastDay.getUTCMonth() + futureMonths);

    // Generate all days in the range (observed + future)
    const allDays: string[] = [];
    const currentDay = new Date(firstDay);
    while (currentDay <= lastDay) {
        allDays.push(fmtDate(currentDay));
        currentDay.setUTCDate(currentDay.getUTCDate() + 1);
    }

    const days = allDays;
    const programs = Array.from(new Set(data.map(d => getBaseBlockName(d.program))));
    // Use more vibrant colors that stand out against twilight backgrounds
    const vibrantColors = [
        '#e74c3c', // bright red
        '#3498db', // bright blue
        '#2ecc71', // bright green
        '#f39c12', // bright orange
        '#9b59b6', // bright purple
        '#1abc9c', // bright teal
        '#e91e63', // bright pink
        '#00bcd4', // bright cyan
        '#ff5722', // deep orange
        '#8bc34a', // light green
        '#ff9800', // orange
        '#673ab7', // deep purple
        '#009688', // teal
        '#ffc107', // amber
        '#795548'  // brown
    ];
    const color = d3.scaleOrdinal<string, string>().domain(programs).range(vibrantColors);

    // Layout - responsive design
    const margin = { top: 20, right: 20, bottom: 20, left: 80 };

    // Make chart width responsive to container
    const containerWidth = chartContainer.node()!.getBoundingClientRect().width - 16; // Account for padding
    const width = Math.max(800, containerWidth); // Minimum 800px width
    const rowHeight = 20;
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = days.length * rowHeight;
    const height = innerHeight + margin.top + margin.bottom;

    const svg = chartContainer
                  .append("svg")
                  .attr("width", width)
                  .attr("height", height);

    const g = svg.append("g")
                 .attr("transform", `translate(${margin.left},${margin.top})`);

    // Scales - x is time (hours since the day boundary), y is days
    const xminHour = 0, xmaxHour = 24;
    const x = d3.scaleLinear()
                .domain([xminHour, xmaxHour])
                .range([0, innerWidth]);

    const y = d3.scaleBand()
                .domain(days)
                .range([0, innerHeight])
                .padding(0.1);

    // Function to calculate twilight times for a given observing day
    function calculateTwilightTimes(astronomicalDayStr: string): TwilightEvent[] {
        try {
            // Create observer object for Cerro Pachón
            const observer = new Astronomy.Observer(CERRO_PACHON_LAT, CERRO_PACHON_LON, CERRO_PACHON_ELEVATION);

            const dayStart = dayNoon(astronomicalDayStr);
            const dayEnd = new Date(dayStart.getTime() + 24 * HOUR_MS);

            const events: TwilightEvent[] = [];

            // Define twilight elevation angles (standard astronomical definitions)
            const twilightEvents = [
                { name: 'sunset', angle: -0.8333, direction: -1 },
                { name: 'civil_dusk', angle: -6, direction: -1 },
                { name: 'nautical_dusk', angle: -12, direction: -1 },
                { name: 'astronomical_dusk', angle: -18, direction: -1 },
                { name: 'astronomical_dawn', angle: -18, direction: +1 },
                { name: 'nautical_dawn', angle: -12, direction: +1 },
                { name: 'civil_dawn', angle: -6, direction: +1 },
                { name: 'sunrise', angle: -0.8333, direction: +1 }
            ];

            // Search for each twilight event
            for (const twilight of twilightEvents) {
                try {
                    // Start search from beginning of observing day
                    const searchTime = Astronomy.MakeTime(dayStart);

                    // Search for altitude crossing within the 24-hour period
                    const result = Astronomy.SearchAltitude(
                        Astronomy.Body.Sun,
                        observer,
                        twilight.direction,
                        searchTime,
                        1.0, // search 1 day
                        twilight.angle
                    );

                    if (result) {
                        const eventDate = result.date;

                        // Check if event falls within our observing day
                        if (eventDate >= dayStart && eventDate < dayEnd) {
                            const minutesSinceNoon = (eventDate.getTime() - dayStart.getTime()) / (1000 * 60);
                            const hoursSinceNoon = minutesSinceNoon / 60;

                            events.push({
                                type: twilight.name,
                                time: eventDate,
                                hours: hoursSinceNoon,
                                minutes: minutesSinceNoon
                            });
                        }
                    }
                } catch (e) {
                    console.warn(`Could not find ${twilight.name} for ${astronomicalDayStr}:`, (e as Error).message);
                }
            }

            // Sort events by time
            events.sort((a, b) => a.minutes - b.minutes);

            return events;

        } catch (error) {
            console.error(`Error calculating twilight for ${astronomicalDayStr}:`, error);
            return [];
        }
    }

    // Function to create twilight background for a single day
    function createTwilightBackground(astronomicalDayStr: string): SkyBackground[] {
        const events = calculateTwilightTimes(astronomicalDayStr);
        const backgrounds: SkyBackground[] = [];

        // Define background colors for different periods
        const colors: Record<SkyState, { color: string; opacity: number }> = {
            day: { color: '#ffffe0', opacity: 0.3 },           // Light yellow
            civil: { color: '#ffa500', opacity: 0.15 },        // Orange
            nautical: { color: '#4169e1', opacity: 0.2 },      // Royal blue
            astronomical: { color: '#191970', opacity: 0.25 }, // Midnight blue
            night: { color: '#1a1a2e', opacity: 0.3 }          // Very dark blue
        };

        // Start with day since the observing day begins around local noon
        let currentMinutes = 0;
        let currentState: SkyState = 'day';

        // If no events found, default to day for the entire period
        if (events.length === 0) {
            backgrounds.push({
                start: 0,
                end: 24,
                type: 'day',
                ...colors.day
            });
            return backgrounds;
        }

        // Process each twilight event
        for (let i = 0; i < events.length; i++) {
            const event = events[i];
            const eventHours = event.minutes / 60; // Convert minutes to hours for display

            // Add background for current state up to this event
            if (eventHours > currentMinutes / 60) {
                backgrounds.push({
                    start: currentMinutes / 60,
                    end: eventHours,
                    type: currentState,
                    ...colors[currentState]
                });
            }

            // Update state based on event type
            switch (event.type) {
                case 'sunset':
                    currentState = 'civil';
                    break;
                case 'civil_dusk':
                    currentState = 'nautical';
                    break;
                case 'nautical_dusk':
                    currentState = 'astronomical';
                    break;
                case 'astronomical_dusk':
                    currentState = 'night';
                    break;
                case 'astronomical_dawn':
                    currentState = 'astronomical';
                    break;
                case 'nautical_dawn':
                    currentState = 'nautical';
                    break;
                case 'civil_dawn':
                    currentState = 'civil';
                    break;
                case 'sunrise':
                    currentState = 'day';
                    break;
            }

            currentMinutes = event.minutes;
        }

        // Add final background from last event to end of day
        const finalHours = currentMinutes / 60;
        if (finalHours < 24) {
            backgrounds.push({
                start: finalHours,
                end: 24,
                type: currentState,
                ...colors[currentState]
            });
        }

        return backgrounds;
    }

    // Function to calculate moon rise and set times for a given observing day
    function calculateMoonTimes(astronomicalDayStr: string): { moonrise: MoonEvent | null; moonset: MoonEvent | null } | null {
        try {
            // Create observer object for Cerro Pachón
            const observer = new Astronomy.Observer(CERRO_PACHON_LAT, CERRO_PACHON_LON, CERRO_PACHON_ELEVATION);

            const dayStart = dayNoon(astronomicalDayStr);
            const dayEnd = new Date(dayStart.getTime() + 24 * HOUR_MS);

            let moonrise: MoonEvent | null = null;
            let moonset: MoonEvent | null = null;

            try {
                // Search for moonrise within this observing day
                const searchStart = Astronomy.MakeTime(dayStart);

                // Use SearchRiseSet to find moonrise and moonset
                const riseSetResult = Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, +1, searchStart, 1.0);

                if (riseSetResult && riseSetResult.date >= dayStart && riseSetResult.date < dayEnd) {
                    const minutesSinceNoon = (riseSetResult.date.getTime() - dayStart.getTime()) / (1000 * 60);
                    moonrise = {
                        time: riseSetResult.date,
                        hours: minutesSinceNoon / 60,
                        minutes: minutesSinceNoon
                    };
                }

                // Search for moonset within this observing day
                const setResult = Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, -1, searchStart, 1.0);

                if (setResult && setResult.date >= dayStart && setResult.date < dayEnd) {
                    const minutesSinceNoon = (setResult.date.getTime() - dayStart.getTime()) / (1000 * 60);
                    moonset = {
                        time: setResult.date,
                        hours: minutesSinceNoon / 60,
                        minutes: minutesSinceNoon
                    };
                }

            } catch (e) {
                console.warn(`Could not find moon rise/set for ${astronomicalDayStr}:`, (e as Error).message);
            }

            return { moonrise, moonset };

        } catch (error) {
            console.error(`Error calculating moon times for ${astronomicalDayStr}:`, error);
            return null;
        }
    }

    // Scrolling: the SPA scrolls its content pane, not the window.
    const scroller = root.closest<HTMLElement>(".app-content") || null;
    function scrollTo(top: number) {
        const target = scroller || window;
        // jsdom (tests) has no scrollTo; a missing one is not worth an error.
        if (typeof target.scrollTo !== "function") return;
        try {
            target.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        } catch {
            /* not scrollable here */
        }
    }
    function scrollToCenter(element: Element | null | undefined) {
        if (!element) return;
        const rect = element.getBoundingClientRect();
        if (scroller) {
            const box = scroller.getBoundingClientRect();
            scrollTo(rect.top - box.top + scroller.scrollTop - box.height / 2);
        } else {
            scrollTo(rect.top + window.pageYOffset - window.innerHeight / 2);
        }
    }
    // Keep a block the arrow keys moved to in view: leave the scroll alone
    // while it is visible, and once it is past the top or bottom of what
    // can be seen (the floating time axes cover the bottom), bring it back
    // to the middle, about half a view's scroll. (The original centred on
    // every move, but on the first block of the chart rather than the
    // selected one, so the view jumped to the top.)
    const floatingAxis = root.querySelector(".guide-floating-axis");
    function keepInView(element: Element | null) {
        if (!element) return;
        const rect = element.getBoundingClientRect();
        const box = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
        const axis = floatingAxis?.getBoundingClientRect();
        const top = box.top;
        const bottom = axis && axis.height > 0 ? Math.min(box.bottom, axis.top) : box.bottom;
        if (rect.top >= top && rect.bottom <= bottom) return;
        const scrolled = scroller ? scroller.scrollTop : window.scrollY;
        scrollTo(scrolled + (rect.top + rect.bottom) / 2 - (top + bottom) / 2);
    }

    // Tooltip (fixed to the viewport, so it works inside a scrolling pane)
    const tooltip = d3.select(document.body)
                      .append("div")
                      .attr("class", "guide-tooltip");
    disposers.push(() => tooltip.remove());

    // Selection state. `selectedBlock` is the part of the selected block on
    // the row it was selected on (the original kept the whole block), so the
    // arrow keys move on from that row rather than from the block's first.
    let selectedBlock: GuideBlockDatum | null = null;
    let highlightedProgram: string | null = null;
    // With a program's summary up: its blocks (whole blocks) in the list's
    // order, and the one the arrow keys are on (none until one is chosen).
    let programOrder: GuideBlockDatum[] = [];
    let programCursor: GuideBlockDatum | null = null;

    // Info panel elements
    const infoPanel = rootSel.select(".guide-info-panel");
    const panelTitle = rootSel.select(".guide-panel-title");
    const panelContent = rootSel.select<HTMLElement>(".guide-panel-content");

    const PLACEHOLDER = `<div class="guide-info-placeholder">
            Click on a block for details or double-click to view all program versions. With a block selected, use the arrow keys to move between blocks (← → along the night, ↑ ↓ to the night before or after), Enter to view its program, and O to open its exposures in the table. In a program, the arrow keys step through its blocks. Use the search box to find specific programs.
        </div>`;

    // Initialize info panel with placeholder content
    function initializeInfoPanel() {
        infoPanel.classed("empty", true);
        panelTitle.text("Selection Info");
        panelContent.html(PLACEHOLDER);
    }

    // Check if search is currently active
    function isSearchActive(): boolean {
        return searchResults.style("display") !== "none";
    }

    // Find the next/previous block for keyboard navigation
    function findAdjacentBlock(direction: Direction): GuideBlockDatum | null {
        if (!selectedBlock || highlightedProgram) {
            return null; // Only navigate when exactly one block is selected
        }

        // Find the currently selected block in the data array
        const currentIndex = data.indexOf(selectedBlock);

        if (currentIndex === -1) return null;

        // Find adjacent block based on direction
        let targetIndex = -1;

        if (direction === 'up' || direction === 'down') {
            // Navigate vertically (different days): to the nearest day with
            // other blocks above (earlier) or below (later), and nowhere from
            // the first or last. The original sorted the other days with a
            // comparator that ignored one of its arguments, so the day it
            // picked depended on the browser's sort and the blocks' order,
            // and from the first or last day it went the other way. The
            // selected block's own parts are skipped, or a block crossing
            // into a day with nothing else on it would be picked again.
            const { day: currentDay, x0: currentX, blockId: currentId } = data[currentIndex];

            const otherDayBlocks = data
                .map((d, i) => ({ data: d, index: i }))
                .filter(({ data: d }) =>
                    d.blockId !== currentId && (direction === 'up' ? d.day < currentDay : d.day > currentDay)
                );

            if (otherDayBlocks.length > 0) {
                // YYYY-MM-DD strings sort chronologically
                const otherDays = otherDayBlocks.map(({ data: d }) => d.day).sort();
                const targetDay = direction === 'up' ? otherDays[otherDays.length - 1] : otherDays[0];
                const targetDayBlocks = otherDayBlocks.filter(({ data: d }) => d.day === targetDay);

                // Find closest block by time on the target day
                const closest = targetDayBlocks.reduce((prev, curr) =>
                    Math.abs(curr.data.x0 - currentX) < Math.abs(prev.data.x0 - currentX) ? curr : prev
                );

                targetIndex = closest.index;
            }
        } else if (direction === 'left' || direction === 'right') {
            // Navigate horizontally (same day, different time)
            const currentDay = data[currentIndex].day;
            const sameDayBlocks = data
                .map((d, i) => ({ data: d, index: i }))
                .filter(({ data: d }) => d.day === currentDay)
                .sort((a, b) => a.data.x0 - b.data.x0);

            const currentPos = sameDayBlocks.findIndex(({ index }) => index === currentIndex);

            if (direction === 'left' && currentPos > 0) {
                targetIndex = sameDayBlocks[currentPos - 1].index;
            } else if (direction === 'right' && currentPos < sameDayBlocks.length - 1) {
                targetIndex = sameDayBlocks[currentPos + 1].index;
            }
        }

        return targetIndex >= 0 ? data[targetIndex] : null;
    }

    // Navigate to a specific block
    function navigateToBlock(targetBlock: GuideBlockDatum | null) {
        if (!targetBlock) return;

        // Clear current selection
        clearSelection();

        // Select the new block
        selectedBlock = targetBlock;

        // Highlight the block visually
        const targetBlocks = g.selectAll<SVGRectElement, GuideBlockDatum>(".block")
            .classed("selected", blockData => blockData.blockId === targetBlock.blockId);

        // Add flash animation
        targetBlocks
            .filter(blockData => blockData.blockId === targetBlock.blockId)
            .classed("flash", true);

        // Show info panel
        showSingleBlockInfo(targetBlock);

        // Keep the part moved to in view
        keepInView(targetBlocks.filter(blockData => blockData === targetBlock).node());
    }

    // Function to show info panel content
    function showInfoPanel() {
        infoPanel.classed("empty", false);
    }

    function hideInfoPanel() {
        infoPanel.classed("empty", true);
        panelTitle.text("Selection Info");
        panelContent.html(PLACEHOLDER);
    }

    function escapeHtml(s: string): string {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // Links open in a new tab, marked with the app's open-in-new-tab glyph
    // (the ViewerIcon box-and-arrow), which also names that for screen
    // readers.
    const NEW_TAB_ICON =
        '<svg class="guide-newtab" role="img" aria-label="(opens in a new tab)" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/><path d="M15 3h6v6M21 3l-9 9"/></svg>';
    function newTabLink(href: string, text: string, { title, external }: { title?: string; external?: boolean } = {}): string {
        const rel = external ? 'noopener noreferrer' : 'noopener';
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        return `<a class="guide-newtab-link" href="${escapeHtml(href)}" target="_blank" rel="${rel}"${titleAttr}>${escapeHtml(text)} ${NEW_TAB_ICON}</a>`;
    }

    // The observing day as a link to that night's camera page (the original
    // listed a "RubinTV" link instead).
    function renderDay(day: string): string {
        const href = dayHref ? dayHref(day) : null;
        if (!href) return day;
        return newTabLink(href, day, { title: "Open this night in RubinTV in a new tab" });
    }

    // The seq range on a night as a link into the camera table (an addition
    // over the original, which showed it as plain text).
    function renderRange(d: GuideBlockDatum, night: GuideNight): string {
        const text = `${night.seq_num_0} - ${night.seq_num_1}`;
        const href = rangeHref ? rangeHref(d, night) : null;
        if (!href) return text;
        return newTabLink(href, text, { title: "Open these exposures in the camera table in a new tab" });
    }

    // A block's seq range on each night it covers. Seq numbers restart at
    // each day_obs rollover, so a block over one comes with its range per
    // night; any other is its own range on the night it is drawn on.
    function nightsOf(d: GuideBlockDatum): GuideNight[] {
        if (d.nights?.length) {
            return d.nights.map(n => {
                const s = String(n.day_obs);
                const day = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
                return { day, seq_num_0: n.seq_num_0, seq_num_1: n.seq_num_1 };
            });
        }
        return [{ day: d.day, seq_num_0: d.seq_num_0, seq_num_1: d.seq_num_1 }];
    }

    function renderLinks(d: GuideBlockDatum, day: string): string {
        const items = (links ? links(d, day) : []).map(l =>
            newTabLink(l.href, l.label, { external: true })
        );
        if (items.length === 0) return '';
        return `
            <div class="info-item">
                <div class="info-label">External links:</div>
                <div>${items.join('<br>')}</div>
            </div>`;
    }

    // Functions for info panels
    function showSingleBlockInfo(d: GuideBlockDatum) {
        // For spanning blocks, use original block's times; otherwise use the data object's times
        const originalBlock = d.originalBlock || d;
        const durationH = originalBlock.durationH || (originalBlock.end.getTime() - originalBlock.begin.getTime()) / HOUR_MS;

        // Get description from translation table if available
        const description = getDescription(d.program);

        // A day and a seq range link for each night the block covers.
        const nights = nightsOf(d);
        const plural = nights.length > 1 ? 's' : '';

        panelTitle.text("Block Information");
        panelContent.html(`
            <div class="info-item">
                <div class="info-label">Program:</div>
                <div>${escapeHtml(d.program)}</div>
            </div>
            ${description ? `
            <div class="info-item">
                <div class="info-label">Description:</div>
                <div class="info-muted info-italic">${escapeHtml(description)}</div>
            </div>
            ` : ''}
            <div class="info-item">
                <div class="info-label">Observation Day${plural}:</div>
                <div>${nights.map(n => renderDay(n.day)).join('<br>')}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Sequence Range${plural}:</div>
                <div>${nights.map(n => renderRange(d, n)).join('<br>')}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Duration:</div>
                <div>${durationH.toFixed(2)} hours</div>
            </div>
            <div class="info-item">
                <div class="info-label">UTC Start:</div>
                <div>${originalBlock.begin.toISOString()}</div>
            </div>
            <div class="info-item">
                <div class="info-label">UTC End:</div>
                <div>${originalBlock.end.toISOString()}</div>
            </div>
            ${renderLinks(d, d.day)}
            ${renderKeys(['<kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> move', '<kbd>Enter</kbd> program'], tableHref(d) !== null)}
        `);
        showInfoPanel();
    }

    // A line of the keys that work in the panel shown, so they can be found.
    function renderKeys(keys: string[], canOpen: boolean): string {
        const all = [...keys, ...(canOpen ? ['<kbd>O</kbd> open in table'] : []), '<kbd>Esc</kbd> clear'];
        return `<div class="guide-keys info-muted info-small">${all.join(' · ')}</div>`;
    }

    // A block's exposures in the camera table on the night clicked: that
    // night's Sequence Range link in the panel.
    function tableHref(d: GuideBlockDatum): string | null {
        if (!rangeHref) return null;
        const nights = nightsOf(d);
        return rangeHref(d, nights.find(n => n.day === d.day) ?? nights[0]);
    }

    // Open a block's exposures in the camera table in a new tab.
    function openInTable(d: GuideBlockDatum) {
        const href = tableHref(d);
        if (href) window.open(href, "_blank", "noopener");
    }

    function showProgramInfo(program: string) {
        // Filter blocks by base program name to include all versions
        // Use original blocks to avoid counting spanning parts multiple times
        const programBlocks = data
            .filter(d => getBaseBlockName(d.program) === program)
            .map(d => d.originalBlock || d); // Get original block if this is a spanning part

        // Remove duplicates (since spanning blocks appear multiple times in data)
        const uniqueBlocks = Array.from(new Set(programBlocks));

        // Calculate total duration, handling cases where durationH might not be present
        const totalDuration = uniqueBlocks.reduce((sum, d) => {
            const duration = d.durationH || (d.end.getTime() - d.begin.getTime()) / HOUR_MS;
            return sum + duration;
        }, 0);
        const blockCount = uniqueBlocks.length;

        // Get all unique versions for display
        const versions = Array.from(new Set(uniqueBlocks.map(d => d.program))).sort();

        // Date range over every row the program is drawn on. (The original
        // left out the parts of blocks crossing the day rollover, so a
        // program of only such blocks showed "No data", and one starting or
        // ending with one showed too short a range.)
        const programDataBlocks = data
            .filter(d => getBaseBlockName(d.program) === program)
            .sort((a, b) => a.day.localeCompare(b.day));

        // Get description for the program
        const description = getDescription(program);

        // The list's order, night then seq, is the arrow keys' order through
        // the program. Whole blocks only (spanning parts were mapped to
        // theirs above), so `day` is each block's first night.
        programOrder = uniqueBlocks.sort((a, b) => {
            const dayCompare = a.day.localeCompare(b.day);
            if (dayCompare !== 0) return dayCompare;
            return a.seq_num_0 - b.seq_num_0;
        });
        programCursor = null;

        panelTitle.text("Program Summary");
        panelContent.html(`
            <div class="info-item">
                <div class="info-label">Program:</div>
                <div>${escapeHtml(program)}${versions.length > 1 ? ` (${versions.length} versions)` : ''}</div>
            </div>
            ${versions.length > 1 ? `
            <div class="info-item">
                <div class="info-label">Versions:</div>
                <div class="info-muted info-small">${escapeHtml(versions.join(', '))}</div>
            </div>
            ` : ''}
            ${description ? `
            <div class="info-item">
                <div class="info-label">Description:</div>
                <div class="info-muted info-italic">${escapeHtml(description)}</div>
            </div>
            ` : ''}
            <div class="info-item">
                <div class="info-label">Total Blocks:</div>
                <div>${blockCount}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Total Duration:</div>
                <div>${totalDuration.toFixed(2)} hours</div>
            </div>
            <div class="info-item">
                <div class="info-label">Average Duration:</div>
                <div>${(totalDuration / blockCount).toFixed(2)} hours</div>
            </div>
            <div class="info-item">
                <div class="info-label">Date Range:</div>
                <div>${programDataBlocks.length > 0 ? `${programDataBlocks[0].day} to ${programDataBlocks[programDataBlocks.length - 1].day}` : 'No data'}</div>
            </div>
            <div class="info-item">
                ${renderKeys(['<kbd>↑</kbd><kbd>↓</kbd> step through blocks', '<kbd>Enter</kbd> show block'], rangeHref !== undefined)}
                <div class="guide-blocks-head">
                    <div class="info-label">Individual Blocks (${blockCount}):</div>
                    <div class="guide-block-row guide-block-cols"><span>Block</span> <span>Seq</span> <span>Hours</span></div>
                </div>
                <div class="guide-block-list">${renderBlockList(programOrder)}</div>
            </div>
        `);
        measureBlockHeads();
        showInfoPanel();
    }

    // The program summary's block list: a group per night, whose date stays
    // pinned while the group is in view, then a line per block with its own
    // name (the original took two lines a block and repeated the night).
    function renderBlockList(blocks: GuideBlockDatum[]): string {
        const nights: GuideBlockDatum[][] = [];
        for (const d of blocks) {
            const night = nights[nights.length - 1];
            if (night && night[0].day === d.day) night.push(d);
            else nights.push([d]);
        }
        return nights.map(night =>
            `<div class="guide-block-night-group"><div class="guide-block-night-head">${night[0].day}</div>`
            + night.map(d => {
                const duration = d.durationH || (d.end.getTime() - d.begin.getTime()) / HOUR_MS;
                return `<div class="guide-block-item guide-block-row" data-block-id="${d.blockId}" data-day="${d.day}" title="Show this block on the chart">`
                    + `<span class="guide-block-name" title="${escapeHtml(d.program)}">${escapeHtml(d.program)}</span> `
                    + `<span>${d.seq_num_0}–${d.seq_num_1}</span> `
                    + `<span>${duration.toFixed(2)}</span>`
                    + `</div>`;
            }).join('')
            + `</div>`
        ).join('');
    }

    // The night headings pin just under the list's own heading, and a row
    // brought into view has to clear both, so measure them.
    let blockHeadsHeight = 0;
    function measureBlockHeads() {
        const content = panelContent.node();
        const list = content?.querySelector<HTMLElement>(".guide-block-list");
        if (!content || !list) return;
        const head = content.querySelector<HTMLElement>(".guide-blocks-head")?.offsetHeight ?? 0;
        const night = list.querySelector<HTMLElement>(".guide-block-night-head")?.offsetHeight ?? 0;
        list.style.setProperty("--blocks-head-h", `${head}px`);
        blockHeadsHeight = head + night;
    }

    // Open the program summary for a program, every block of it highlighted
    // on the chart, with `current` (when given) the block the arrow keys are
    // on. Double-click and Enter on a block come here.
    function openProgram(baseProgram: string, current: GuideBlockDatum | null) {
        clearSelection();
        highlightedProgram = baseProgram;
        g.selectAll<SVGRectElement, GuideBlockDatum>(".block")
            .classed("highlighted", d => getBaseBlockName(d.program) === baseProgram)
            .classed("flash", d => getBaseBlockName(d.program) === baseProgram);
        showProgramInfo(baseProgram);
        if (current) setProgramCursor(current.originalBlock || current, { focus: false, chart: true });
    }

    // Put the program's cursor on `block` (a whole block): outline it on the
    // chart and mark its row in the list, bringing the row into view below
    // the pinned headings and, with `chart`, the block into view. `focus`
    // also makes it the one block flashing.
    function setProgramCursor(block: GuideBlockDatum, { focus, chart }: { focus: boolean; chart: boolean }) {
        programCursor = block;
        const rects = g.selectAll<SVGRectElement, GuideBlockDatum>(".block")
            .classed("selected", d => d.blockId === block.blockId);
        if (focus) rects.classed("flash", d => d.blockId === block.blockId);
        if (chart) keepInView(rects.filter(d => d.blockId === block.blockId).node());

        const content = panelContent.node();
        content?.querySelectorAll(".guide-block-item.current").forEach(row => row.classList.remove("current"));
        content?.querySelector(`.guide-block-item[data-block-id="${block.blockId}"]`)?.classList.add("current");
        keepRowInView();
    }

    // The current row of the list, and what of the panel shows below the
    // pinned headings.
    function currentRow() {
        const row = panelContent.node()?.querySelector(".guide-block-item.current");
        const panel = infoPanel.node() as HTMLElement | null;
        if (!row || !panel) return null;
        const box = row.getBoundingClientRect();
        const panelBox = panel.getBoundingClientRect();
        const top = panelBox.top + blockHeadsHeight;
        return { panel, box, top, bottom: panelBox.bottom, inView: box.top >= top && box.bottom <= panelBox.bottom };
    }

    // As the chart does: leave the list while the current row is in view,
    // and once it isn't, bring it to the middle of what shows of the list.
    function keepRowInView() {
        const row = currentRow();
        if (!row || row.inView) return;
        row.panel.scrollTop += (row.box.top + row.box.bottom) / 2 - (row.top + row.bottom) / 2;
    }

    // Step the program's cursor through its blocks in the list's order; from
    // none, Down starts at the first and Up at the last. It stays at the ends.
    function stepProgram(step: 1 | -1) {
        if (programOrder.length === 0) return;
        const at = programCursor ? programOrder.indexOf(programCursor) : -1;
        const next = at === -1 ? (step === 1 ? 0 : programOrder.length - 1) : at + step;
        if (next < 0 || next >= programOrder.length) return;
        setProgramCursor(programOrder[next], { focus: true, chart: true });
    }

    // Function to select a block by its blockId (from the program summary list)
    function selectBlockById(blockId: number, day?: string) {
        // Find the block with this blockId in the data array, preferring the one on the specified day
        let blockData: GuideBlockDatum | undefined;
        if (day) {
            blockData = data.find(d => d.blockId === blockId && d.day === day);
        }
        if (!blockData) {
            blockData = data.find(d => d.blockId === blockId);
        }
        if (!blockData) return;

        // Don't change the program summary view: make it the program's
        // current block (the arrow keys carry on from it), which flashes it,
        // and scroll to it
        setProgramCursor(blockData.originalBlock || blockData, { focus: true, chart: false });
        const selectedBlocks = g.selectAll<SVGRectElement, GuideBlockDatum>(".block")
            .filter(d => d.blockId === blockId);

        // Scroll to the block on the specific day if provided
        let blockElement: SVGRectElement | null | undefined;
        if (day) {
            blockElement = selectedBlocks.nodes().find(n => d3.select<SVGRectElement, GuideBlockDatum>(n).datum().day === day);
        }
        if (!blockElement) {
            blockElement = selectedBlocks.node();
        }

        scrollToCenter(blockElement);
    }

    // Delegated clicks inside the panel: the program summary's block rows.
    panelContent.on("click", function(event: MouseEvent) {
        const item = (event.target as Element).closest<HTMLElement>(".guide-block-item");
        if (item) {
            selectBlockById(Number(item.dataset.blockId), item.dataset.day);
        }
    });

    function clearSelection() {
        selectedBlock = null;
        highlightedProgram = null;
        programOrder = [];
        programCursor = null;
        g.selectAll(".block")
            .classed("selected", false)
            .classed("highlighted", false)
            .classed("flash", false);
        hideInfoPanel();
    }

    // Search functionality
    const searchInput = rootSel.select<HTMLInputElement>(".guide-search-input");
    const searchResults = rootSel.select<HTMLDivElement>(".guide-search-results");
    let selectedSearchIndex = -1; // Track which search result is selected
    let currentSearchResults: SearchResult[] = []; // Store current search results for navigation

    // Simple fuzzy matching function
    function fuzzyMatch(pattern: string, text: string): FuzzyMatch {
        pattern = pattern.toLowerCase();
        text = text.toLowerCase();

        // Exact match gets highest score
        if (text.includes(pattern)) {
            return { score: 1000, matched: true };
        }

        // Character-by-character fuzzy matching
        let patternIndex = 0;
        let score = 0;

        for (let i = 0; i < text.length && patternIndex < pattern.length; i++) {
            if (text[i] === pattern[patternIndex]) {
                score += 1;
                patternIndex++;
            }
        }

        // Return match if we found all pattern characters
        const matched = patternIndex === pattern.length;
        return { score: matched ? score : 0, matched };
    }

    function performSearch(query: string) {
        if (query.length === 0) {
            searchResults.style("display", "none");
            return;
        }

        // Get all unique full program names (including versions) from the data
        const allProgramNames = Array.from(new Set(data.map(d => d.program)));

        // Create a map from base program to all its versions
        const programVersions: Record<string, string[]> = {};
        allProgramNames.forEach(fullProgram => {
            const baseProgram = getBaseBlockName(fullProgram);
            if (!programVersions[baseProgram]) {
                programVersions[baseProgram] = [];
            }
            programVersions[baseProgram].push(fullProgram);
        });

        // Search across base programs and their versions
        const rankedPrograms: SearchResult[] = programs
            .map(program => {
                let bestMatch: FuzzyMatch = { score: 0, matched: false };
                let matchingVersions: string[] = [];

                // Search against base program name
                const programMatch = fuzzyMatch(query, program);
                if (programMatch.matched) {
                    bestMatch = programMatch;
                    matchingVersions = programVersions[program] || [program];
                }

                // Search against all versions of this program
                const versions = programVersions[program] || [program];
                versions.forEach(version => {
                    const versionMatch = fuzzyMatch(query, version);
                    if (versionMatch.matched && versionMatch.score > bestMatch.score) {
                        bestMatch = versionMatch;
                        matchingVersions = [version]; // If version-specific match, show only that version
                    }
                });

                // Also search against descriptive title if available
                const description = getDescription(program) || "";
                const descriptionMatch = description ? fuzzyMatch(query, description) : { score: 0, matched: false };
                if (descriptionMatch.matched && descriptionMatch.score > bestMatch.score) {
                    bestMatch = descriptionMatch;
                    matchingVersions = programVersions[program] || [program]; // Show all versions for description match
                }

                return {
                    program,
                    ...bestMatch,
                    description, // Store description for display
                    matchingVersions // Store which versions matched
                };
            })
            .filter(item => item.matched)
            .sort((a, b) => b.score - a.score); // Sort by score descending

        if (rankedPrograms.length === 0) {
            searchResults.style("display", "none");
            currentSearchResults = [];
            selectedSearchIndex = -1;
            return;
        }

        // Store results for keyboard navigation
        currentSearchResults = rankedPrograms;
        selectedSearchIndex = -1; // Reset selection

        // Display search results
        const items = searchResults
            .style("display", "block")
            .selectAll<HTMLDivElement, SearchResult>(".search-result-item")
            .data(rankedPrograms, d => d.program);

        // Remove all existing items first to ensure proper ordering
        items.exit().remove();

        // Create new items in the correct order
        const newItems = items.enter()
            .append("div")
            .attr("class", "search-result-item");

        // Merge and update all items
        const allItems = newItems.merge(items)
            .html(d => {
                const description = d.description;
                const versions = d.matchingVersions || [d.program];

                // Create version display
                let versionText = '';
                if (versions.length > 1) {
                    versionText = `<div class="search-versions">${versions.length} versions: ${escapeHtml(versions.join(', '))}</div>`;
                } else if (versions[0] !== d.program) {
                    // Show the specific version if it's different from base program
                    versionText = `<div class="search-versions">Version: ${escapeHtml(versions[0])}</div>`;
                }

                if (description) {
                    return `<div class="search-program">${escapeHtml(d.program)}</div><div class="search-description">${escapeHtml(description)}</div>${versionText}`;
                } else {
                    return `<div class="search-program">${escapeHtml(d.program)}</div>${versionText}`;
                }
            })
            .classed("search-highlighted", (_d, i) => i === selectedSearchIndex)
            .on("click", function(_event, d) {
                selectProgram(d.program);
                searchInput.node()!.value = "";
                searchResults.style("display", "none");
                currentSearchResults = [];
                selectedSearchIndex = -1;
            });

        // Ensure DOM order matches data order
        allItems.order();
    }

    // Function to update search result highlighting
    function updateSearchHighlight() {
        searchResults.selectAll(".search-result-item")
            .classed("search-highlighted", (_d, i) => i === selectedSearchIndex);

        // Scroll the selected item into view
        if (selectedSearchIndex >= 0) {
            const selectedElement = searchResults.selectAll<HTMLDivElement, SearchResult>(".search-result-item").nodes()[selectedSearchIndex];
            if (selectedElement && selectedElement.scrollIntoView) {
                selectedElement.scrollIntoView({
                    behavior: 'smooth',
                    block: 'nearest'
                });
            }
        }
    }

    function selectProgram(program: string) {
        clearSelection();
        const baseProgram = getBaseBlockName(program);

        // Find all blocks for this program. A block crossing the day
        // rollover is drawn as a part per row, so count blocks, not parts
        // (the original counted parts, and a lone block across the rollover
        // got the program summary).
        const programBlocks = data.filter(d => getBaseBlockName(d.program) === baseProgram);
        const blockCount = new Set(programBlocks.map(d => d.blockId)).size;

        if (blockCount === 1) {
            // Exactly one block - show block information instead of program summary
            const singleBlock = programBlocks[0];
            selectedBlock = singleBlock;

            // Highlight just this single block
            const selectedBlocks = g.selectAll<SVGRectElement, GuideBlockDatum>(".block")
                .classed("selected", blockData => blockData.blockId === singleBlock.blockId);

            // Add flash animation to selected block
            selectedBlocks
                .filter(blockData => blockData.blockId === singleBlock.blockId)
                .classed("flash", true);

            showSingleBlockInfo(singleBlock);

            // Scroll to this block (the original scrolled to the first
            // block of the chart: `selectedBlocks` is every block)
            scrollToCenter(selectedBlocks.filter(blockData => blockData === singleBlock).node());
        } else {
            // Multiple blocks - show program summary as before, with no
            // current block until the arrow keys or a row choose one
            openProgram(baseProgram, null);

            // Scroll to the first block of this program
            const firstBlock = data.find(d => getBaseBlockName(d.program) === baseProgram);
            if (firstBlock) {
                const blockElement = g.selectAll<SVGRectElement, GuideBlockDatum>(".block")
                    .filter(d => d === firstBlock)
                    .node();
                scrollToCenter(blockElement);
            }
        }
    }

    // Search input event listeners
    searchInput.on("input", function() {
        const query = this.value.trim();
        performSearch(query);
    });

    searchInput.on("keydown", function(event: KeyboardEvent) {
        if (event.key === "Escape") {
            this.value = "";
            searchResults.style("display", "none");
            currentSearchResults = [];
            selectedSearchIndex = -1;
            this.blur();
        } else if (event.key === "ArrowDown") {
            event.preventDefault();
            if (currentSearchResults.length > 0) {
                selectedSearchIndex = Math.min(selectedSearchIndex + 1, currentSearchResults.length - 1);
                updateSearchHighlight();
            }
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            if (currentSearchResults.length > 0) {
                selectedSearchIndex = Math.max(selectedSearchIndex - 1, -1);
                updateSearchHighlight();
            }
        } else if (event.key === "Enter") {
            event.preventDefault();
            if (selectedSearchIndex >= 0 && selectedSearchIndex < currentSearchResults.length) {
                const selectedResult = currentSearchResults[selectedSearchIndex];
                selectProgram(selectedResult.program);
                this.value = "";
                searchResults.style("display", "none");
                currentSearchResults = [];
                selectedSearchIndex = -1;
            }
        }
    });

    // Hide search results when clicking outside
    const onDocumentClick = (event: MouseEvent) => {
        if (!(event.target as Element).closest(".guide-search-container")) {
            searchResults.style("display", "none");
        }
    };
    document.addEventListener("click", onDocumentClick);
    disposers.push(() => document.removeEventListener("click", onDocumentClick));

    // Add axes
    // Y-axis (observation days) - keep this in the main chart
    const yAxis = d3.axisLeft(y);

    g.append("g")
        .attr("class", "y-axis")
        .call(yAxis);

    // Create floating bottom axes
    const floatingAxisSvg = rootSel.select<SVGSVGElement>(".guide-floating-axis-svg");
    floatingAxisSvg.selectAll("*").remove();
    floatingAxisSvg
        .attr("width", width)
        .attr("height", 155);

    // The axis SVG is fixed to the viewport while the chart sits inside the
    // page's padding, so its origin is measured from the chart rather than
    // assumed: whatever is left of the chart (app padding, chart padding)
    // is added to the chart's own left margin.
    const floatingG = floatingAxisSvg.append("g");
    function alignFloatingAxis() {
        const chartLeft = svg.node()!.getBoundingClientRect().left;
        const axisLeft = floatingAxisSvg.node()!.getBoundingClientRect().left;
        const shift = Math.round(chartLeft - axisLeft);
        floatingAxisSvg.attr("width", width + Math.max(0, shift));
        floatingG.attr("transform", `translate(${margin.left + shift},15)`);
    }
    alignFloatingAxis();

    // The info column sticks to the top of the scroll pane and scrolls
    // within itself; keep it clear of the floating axes, which would hide
    // its last lines, by ending it at their top edge. Its top is lower
    // until the page has scrolled far enough for it to stick, so it is
    // refitted as the page scrolls. (Only while it is sticky: stacked
    // above the chart on narrow screens it is not.)
    const infoColumn = root.querySelector<HTMLElement>(".guide-info-container");
    function fitInfoColumn() {
        if (!infoColumn) return;
        const axis = floatingAxis?.getBoundingClientRect();
        const room = axis ? Math.floor(axis.top - infoColumn.getBoundingClientRect().top - 8) : 0;
        const sticky = getComputedStyle(infoColumn).position === "sticky";
        const maxHeight = sticky && axis && axis.height > 0 && room > 0 ? `${room}px` : "";
        if (infoColumn.style.maxHeight === maxHeight) return;
        // A current row in view stays in view as the column changes size
        // (scrolled away from by hand, it is left alone).
        const keepRow = currentRow()?.inView ?? false;
        infoColumn.style.maxHeight = maxHeight;
        if (keepRow) keepRowInView();
    }
    fitInfoColumn();
    let fitFrame = 0;
    const onScroll = () => {
        if (!fitFrame) fitFrame = requestAnimationFrame(() => { fitFrame = 0; fitInfoColumn(); });
    };
    const scrolled = scroller || window;
    scrolled.addEventListener("scroll", onScroll, { passive: true });
    disposers.push(() => {
        scrolled.removeEventListener("scroll", onScroll);
        cancelAnimationFrame(fitFrame);
        if (infoColumn) infoColumn.style.maxHeight = "";
    });

    const onResize = () => {
        alignFloatingAxis();
        fitInfoColumn();
        measureBlockHeads(); // the list heading may wrap differently
    };
    window.addEventListener("resize", onResize);
    disposers.push(() => window.removeEventListener("resize", onResize));

    // Determine which Chilean timezone is currently active: CLST (UTC-3) in
    // the southern summer, CLT (UTC-4) the rest of the year. Read from the
    // browser's time-zone data for America/Santiago (which Cerro Pachón
    // keeps) rather than the original's month rules, which counted all of
    // September as summer time and ended it a day early in April; the
    // switch dates are set by decree and the tz data follows them.
    function isChileSummerTime(date: Date): boolean {
        const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', timeZoneName: 'shortOffset' })
            .formatToParts(date)
            .find(part => part.type === 'timeZoneName')?.value;
        return offset === 'GMT-3';
    }

    const currentDate = new Date();
    const isSummerTime = isChileSummerTime(currentDate);
    const cltOpacity = isSummerTime ? 0.3 : 1.0;
    const clstOpacity = isSummerTime ? 1.0 : 0.3;

    // Hours since the day boundary -> clock hour in a zone `offset` hours from UTC
    function clockLabel(d: number, offset: number): string {
        let hour = (d + DAY_START + offset) % 24;
        if (hour < 0) hour += 24;
        return hour.toString().padStart(2, '0') + ":00";
    }

    function addAxis(yOffset: number, offset: number, cls: string, opacity: number) {
        const axis = d3.axisBottom(x)
                       .tickFormat(d => clockLabel(Number(d), offset))
                       .ticks(12)
                       .tickSize(6)
                       .tickSizeOuter(0);
        floatingG.append("g")
            .attr("class", `x-axis ${cls}`)
            .attr("transform", `translate(0,${yOffset})`)
            .style("opacity", opacity)
            .call(axis);

        // Minor ticks (every hour, unlabeled)
        const minor = d3.axisBottom(x)
                        .ticks(24)
                        .tickFormat(() => "")
                        .tickSize(3);
        floatingG.append("g")
            .attr("class", "x-axis-minor")
            .attr("transform", `translate(0,${yOffset})`)
            .style("opacity", opacity)
            .call(minor);
    }

    function addAxisLabel(yOffset: number, text: string, opacity: number) {
        floatingG.append("text")
            .attr("class", "axis-label")
            .attr("x", -10)
            .attr("y", yOffset)
            .style("text-anchor", "end")
            .style("font-size", "10px")
            .style("opacity", opacity)
            .text(text);
    }

    // UTC, Chile Standard Time (UTC-4), Chile Summer Time (UTC-3), then the
    // browser's local zone.
    const localTimezoneOffset = -new Date().getTimezoneOffset() / 60; // Convert minutes to hours, flip sign
    addAxis(0, 0, "x-axis-utc", 1.0);
    addAxis(35, -4, "x-axis-clt", cltOpacity);
    addAxis(70, -3, "x-axis-clst", clstOpacity);
    addAxis(105, localTimezoneOffset, "x-axis-local", 1.0);

    // Get local timezone abbreviation or offset for label
    const localTimezoneLabel = (() => {
        const formatter = new Intl.DateTimeFormat('en', { timeZoneName: 'short' });
        const parts = formatter.formatToParts(new Date());
        const tzName = parts.find(part => part.type === 'timeZoneName')?.value;
        // Return timezone name if available, otherwise show UTC offset
        if (tzName && tzName !== 'GMT') {
            return tzName;
        }
        const offset = localTimezoneOffset;
        const sign = offset >= 0 ? '+' : '-';
        return `UTC${sign}${Math.abs(offset)}`;
    })();

    addAxisLabel(5, "UTC", 1.0);
    addAxisLabel(40, "CLT (UTC-4)", cltOpacity);
    addAxisLabel(75, "CLST (UTC-3)", clstOpacity);
    addAxisLabel(110, `Local (${localTimezoneLabel})`, 1.0);

    // Draw twilight backgrounds
    days.forEach(day => {
        const backgrounds = createTwilightBackground(day);

        backgrounds.forEach(bg => {
            g.append("rect")
                .attr("class", "twilight-background")
                .attr("x", x(bg.start))
                .attr("y", y(day)!)
                .attr("width", x(bg.end) - x(bg.start))
                .attr("height", y.bandwidth())
                .attr("fill", bg.color)
                .attr("opacity", bg.opacity)
                .style("pointer-events", "none"); // Don't interfere with block interactions
        });
    });

    // Draw month separator lines
    days.forEach((day, index) => {
        if (index === 0) return; // Skip first day

        // Parse as YYYY-MM-DD strings to compare
        const currentParts = day.split('-');
        const prevParts = days[index - 1].split('-');

        const currentYear = parseInt(currentParts[0]);
        const currentMonth = parseInt(currentParts[1]);
        const prevYear = parseInt(prevParts[0]);
        const prevMonth = parseInt(prevParts[1]);

        // Check if this is the first day of a new month
        if (currentYear !== prevYear || currentMonth !== prevMonth) {
            // Draw line at the top of this row, shifted up 1 pixel to be visible above blocks
            g.append("line")
                .attr("class", "month-separator")
                .attr("x1", 0)
                .attr("x2", innerWidth)
                .attr("y1", y(day)! - 1)
                .attr("y2", y(day)! - 1)
                .attr("stroke-width", 1.5)
                .style("pointer-events", "none");
        }
    });

    // Draw moon overlays
    days.forEach(day => {
        const moonTimes = calculateMoonTimes(day);

        if (moonTimes && (moonTimes.moonrise || moonTimes.moonset)) {
            // Determine the period when the moon is visible (above horizon)
            let moonVisibleStart: number | null = null;
            let moonVisibleEnd: number | null = null;

            if (moonTimes.moonrise && moonTimes.moonset) {
                // Both rise and set within the day
                if (moonTimes.moonrise.hours < moonTimes.moonset.hours) {
                    // Normal case: rise then set
                    moonVisibleStart = moonTimes.moonrise.hours;
                    moonVisibleEnd = moonTimes.moonset.hours;
                } else {
                    // Moon sets before it rises (was already up at start of day)
                    // Create two segments: start to set, and rise to end
                    g.append("rect")
                        .attr("class", "moon-overlay")
                        .attr("x", x(0))
                        .attr("y", y(day)!)
                        .attr("width", x(moonTimes.moonset.hours) - x(0))
                        .attr("height", y.bandwidth())
                        .attr("fill", "#b3d9ff")
                        .attr("opacity", 0.4)
                        .style("pointer-events", "none");

                    moonVisibleStart = moonTimes.moonrise.hours;
                    moonVisibleEnd = 24;
                }
            } else if (moonTimes.moonrise) {
                // Only moonrise within the day
                moonVisibleStart = moonTimes.moonrise.hours;
                moonVisibleEnd = 24;
            } else if (moonTimes.moonset) {
                // Only moonset within the day (moon was up at start)
                moonVisibleStart = 0;
                moonVisibleEnd = moonTimes.moonset.hours;
            }

            // Draw the main moon visibility period
            if (moonVisibleStart !== null && moonVisibleEnd !== null) {
                g.append("rect")
                    .attr("class", "moon-overlay")
                    .attr("x", x(moonVisibleStart))
                    .attr("y", y(day)!)
                    .attr("width", x(moonVisibleEnd) - x(moonVisibleStart))
                    .attr("height", y.bandwidth())
                    .attr("fill", "#b3d9ff")  // More saturated blue
                    .attr("opacity", 0.4)     // Nice balance of visibility
                    .style("pointer-events", "none"); // Don't interfere with block interactions
            }
        }
    });

    // Draw Blocks
    g.selectAll<SVGRectElement, GuideBlockDatum>("rect.block")
        .data(data)
        .join("rect")
            .attr("class", "block")
            .attr("x", d => x(d.x0))
            .attr("y", d => y(d.day)!)
            .attr("width", d => x(d.x1) - x(d.x0))
            .attr("height", y.bandwidth())
            .attr("fill", d => color(getBaseBlockName(d.program)))
            .attr("fill-opacity", 0.9)
            .attr("stroke", "#333")
            .attr("stroke-width", 0.5)
            .on("click", function(event: MouseEvent, d) {
                event.stopPropagation();
                clearSelection();
                selectedBlock = d; // The part clicked, so arrow keys move on from its row

                // Highlight all parts of this block (for spanning blocks)
                const selectedBlocks = g.selectAll<SVGRectElement, GuideBlockDatum>(".block")
                    .classed("selected", blockData => blockData.blockId === d.blockId);

                // Add flash animation to selected blocks
                selectedBlocks
                    .filter(blockData => blockData.blockId === d.blockId)
                    .classed("flash", true);

                showSingleBlockInfo(d); // Always pass the clicked data object, not original
            })
            .on("dblclick", function(event: MouseEvent, d) {
                event.stopPropagation();
                // The program of every version, from this block
                openProgram(getBaseBlockName(d.program), d);
            })
            .on("mouseenter", function(_event, d) {
                const originalBlock = d.originalBlock || d;
                const durationH = originalBlock.durationH || (originalBlock.end.getTime() - originalBlock.begin.getTime()) / HOUR_MS;
                tooltip
                    .style("opacity", 1)
                    .html(
                        `Program: ${escapeHtml(d.program)}<br>` +
                        `Day: ${d.day}<br>` +
                        `Begin: ${fmtTime(originalBlock.begin)}<br>` +
                        `End: ${fmtTime(originalBlock.end)}<br>` +
                        `Duration: ${durationH.toFixed(2)} h${d.isSpanningPart ? ' (spans days)' : ''}`
                    );
            })
            .on("mousemove", (event: MouseEvent) => {
                tooltip
                    .style("left", (event.clientX + 10) + "px")
                    .style("top", (event.clientY + 10) + "px");
            })
            .on("mouseleave", () => {
                tooltip.style("opacity", 0);
            });

    // Click away to deselect
    svg.on("click", function() {
        clearSelection();
    });

    // Global keyboard shortcuts
    const onKeydown = (event: KeyboardEvent) => {
        // Don't trigger if user is already typing in the search box or other input
        const target = event.target as Element;
        if (target.closest?.("input, textarea, select, [contenteditable]")) {
            return;
        }

        if (event.key === "/" || (event.ctrlKey && event.key === "f")) {
            event.preventDefault();
            searchInput.node()!.focus();
            return;
        }
        // Leave the browser's own shortcuts alone, and the keys to the
        // search results while they are open. Enter on a focused link or
        // button in the panel is the link's.
        if (event.metaKey || event.ctrlKey || event.altKey || isSearchActive()) return;
        const onControl = !!target.closest?.("a, button");
        if (highlightedProgram) {
            programKey(event, onControl);
        } else if (selectedBlock) {
            blockKey(event, onControl);
        }
    };

    // Keys with a single block selected: the arrows move to its neighbours,
    // Enter opens its program, O opens its exposures in the table.
    function blockKey(event: KeyboardEvent, onControl: boolean) {
        const current = selectedBlock!;
        let targetBlock: GuideBlockDatum | null = null;

        switch(event.key) {
            case 'ArrowUp':
                event.preventDefault();
                targetBlock = findAdjacentBlock('up');
                break;
            case 'ArrowDown':
                event.preventDefault();
                targetBlock = findAdjacentBlock('down');
                break;
            case 'ArrowLeft':
                event.preventDefault();
                targetBlock = findAdjacentBlock('left');
                break;
            case 'ArrowRight':
                event.preventDefault();
                targetBlock = findAdjacentBlock('right');
                break;
            case 'Escape':
                event.preventDefault();
                clearSelection();
                break;
            case 'Enter':
                if (onControl) return;
                event.preventDefault();
                openProgram(getBaseBlockName(current.program), current);
                break;
            case 'o':
            case 'O':
                event.preventDefault();
                openInTable(current);
                break;
        }

        if (targetBlock) {
            navigateToBlock(targetBlock);
        }
    }

    // Keys in a program's summary: the arrows step through its blocks in the
    // list's order, Enter shows the current one on its own (where the arrows
    // then move to its neighbours), O opens it in the table.
    function programKey(event: KeyboardEvent, onControl: boolean) {
        switch(event.key) {
            case 'ArrowDown':
            case 'ArrowRight':
                event.preventDefault();
                stepProgram(1);
                break;
            case 'ArrowUp':
            case 'ArrowLeft':
                event.preventDefault();
                stepProgram(-1);
                break;
            case 'Escape':
                event.preventDefault();
                clearSelection();
                break;
            case 'Enter': {
                if (onControl || !programCursor) return;
                event.preventDefault();
                const blockId = programCursor.blockId;
                navigateToBlock(data.find(d => d.blockId === blockId) ?? null);
                break;
            }
            case 'o':
            case 'O':
                if (!programCursor) return;
                event.preventDefault();
                openInTable(programCursor);
                break;
        }
    }
    document.addEventListener("keydown", onKeydown);
    disposers.push(() => document.removeEventListener("keydown", onKeydown));

    // Initialize the info panel with placeholder text
    initializeInfoPanel();

    // Scroll to show the current date
    // Wait a bit for rendering to complete
    const timer = setTimeout(() => {
        const todayStr = getAstronomicalDay(new Date());
        const todayRow = days.indexOf(todayStr);

        if (todayRow !== -1) {
            const rowY = margin.top + todayRow * rowHeight;
            const viewportHeight = scroller ? scroller.clientHeight : window.innerHeight;
            scrollTo(rowY - (viewportHeight / 2) + (rowHeight / 2));
        }
    }, 100);
    disposers.push(() => clearTimeout(timer));

    return {
        dispose() {
            disposers.forEach(fn => fn());
            chartContainer.selectAll("*").remove();
            floatingAxisSvg.selectAll("*").remove();
            searchInput.on("input", null).on("keydown", null);
            panelContent.on("click", null);
        },
    };
}
