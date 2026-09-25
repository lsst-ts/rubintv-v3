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
 * module the Guide view mounts into a root element (no global ids, no
 * window globals, disposable listeners), the data arrives as arguments
 * instead of being fetched, the day boundary is the observatory's day_obs
 * rollover rather than Chilean noon, block links come from the caller,
 * and scrolling targets the app's scroll container. The chart itself —
 * layout, colours, twilight and moon calculation, selection, search and
 * keyboard behaviour — is the original's.
 */

import * as d3 from "d3";
import * as Astronomy from "astronomy-engine";

// Cerro Pachón coordinates (Rubin Observatory)
const CERRO_PACHON_LAT = -30.2408;
const CERRO_PACHON_LON = -70.7364;
const CERRO_PACHON_ELEVATION = 2715; // meters

const HOUR_MS = 3600000;

/**
 * Render the timeline into `root`.
 *
 * @param {HTMLElement} root  element containing the `.guide-*` hooks
 * @param {object} opts
 * @param {Array} opts.blocks         [{program, begin, end, seq_num_0, seq_num_1}]
 * @param {Record<string,string>} opts.names  program key → description
 * @param {number} opts.dayStartUtcHour  UTC hour a day_obs row begins at
 * @param {(d: object, day: string) => Array<{label: string, href: string, internal?: boolean}>} opts.links
 * @param {(d: object, day: string) => string | null} [opts.rangeHref]  in-app route for a block's seq range
 * @param {(path: string) => void} opts.onNavigate  in-app navigation for internal links
 * @param {number} [opts.minBlockMinutes=5]  hide blocks shorter than this
 * @param {number} [opts.futureMonths=6]  empty rows to draw past the last block
 * @returns {{ dispose: () => void }}
 */
export function renderGuide(root, opts) {
    const {
        names: tblockNames,
        dayStartUtcHour: DAY_START,
        links,
        rangeHref,
        onNavigate,
        minBlockMinutes = 5,
        futureMonths = 6,
    } = opts;
    const rootSel = d3.select(root);
    const disposers = [];

    // Parse date strings to Date objects (copies: the caller's data is
    // react-query state and must not be mutated).
    let blocks = opts.blocks.map(d => ({
        ...d,
        begin: new Date(d.begin),
        end: new Date(d.end),
    }));

    // Filter out short blocks (5 minutes in the original)
    blocks = blocks.filter(d => (d.end - d.begin) >= minBlockMinutes * 60000);

    // Helper function to get the base block name (without version suffix)
    function getBaseBlockName(program) {
        // Remove version suffixes like _v3, _v2, _1, _2, _hexapods, etc.
        // This handles both numeric versions (_v3, _1, _2) and descriptive versions (_hexapods)
        return program.replace(/_(?:v)?\d+$|_[a-zA-Z][a-zA-Z0-9_]*$/, '');
    }

    // Helper function to get the correct T-block name for description lookup
    function getDescriptionKey(program) {
        // First remove any version suffix
        const baseProgram = getBaseBlockName(program);

        // If program is BLOCK-XYZ format (without T), try BLOCK-TXYZ
        const blockMatch = baseProgram.match(/^BLOCK-(\d+)$/);
        if (blockMatch) {
            const tBlockName = `BLOCK-T${blockMatch[1]}`;
            // Use T-block version if it exists in translation table, otherwise use base
            return tblockNames[tBlockName] ? tBlockName : baseProgram;
        }
        return baseProgram;
    }

    // Helper function to get description for a program
    function getDescription(program) {
        const descriptionKey = getDescriptionKey(program);
        return tblockNames[descriptionKey];
    }

    // Formatting helpers
    const fmtDate = d3.utcFormat("%Y-%m-%d"); // Use UTC formatting for dates too
    const fmtTime = d3.utcFormat("%H:%M"); // Use UTC formatting to match the astronomical convention

    // Observing-day functions - the day runs from DAY_START UTC to DAY_START UTC
    // the next calendar day (noon UTC for day_obs, matching the rest of RubinTV).
    function dayNoon(dayStr) {
        const [year, month, day] = dayStr.split('-').map(Number);
        return new Date(Date.UTC(year, month - 1, day, DAY_START, 0, 0));
    }

    function getAstronomicalDay(date) {
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
    const data = [];

    blocks.forEach((d, blockIndex) => {
        const startDay = getAstronomicalDay(d.begin);
        const endDay = getAstronomicalDay(d.end);
        const startDayNoon = dayNoon(startDay);

        // Calculate positions relative to the start day's boundary
        const x0 = (d.begin - startDayNoon) / HOUR_MS;
        const x1 = (d.end - startDayNoon) / HOUR_MS;
        const durationH = (d.end - d.begin) / HOUR_MS;

        if (startDay === endDay) {
            // Block doesn't span days, add as-is
            data.push({ ...d, day: startDay, x0, x1, durationH, originalBlock: null, isSpanningPart: false, blockId: blockIndex });
        } else {
            // Block spans across days - create entries for each day it touches
            const spanDays = [];
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
                        x0: (d.begin - noon) / HOUR_MS,
                        x1: 24,
                        durationH: durationH, // Keep original duration for info display
                        originalBlock: d,
                        isSpanningPart: true,
                        blockId: blockIndex
                    });
                } else if (dayIndex === spanDays.length - 1) {
                    // Last day: from start of observing day to actual end time
                    data.push({
                        ...d,
                        day: dayStr,
                        x0: 0,
                        x1: (d.end - noon) / HOUR_MS,
                        durationH: durationH,
                        originalBlock: d,
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
                        originalBlock: d,
                        isSpanningPart: true,
                        blockId: blockIndex
                    });
                }
            });
        }
    });

    const chartContainer = rootSel.select(".guide-chart");
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
    const allDays = [];
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
    const color = d3.scaleOrdinal().domain(programs).range(vibrantColors);

    // Layout - responsive design
    const margin = { top: 20, right: 20, bottom: 20, left: 80 };

    // Make chart width responsive to container
    const containerWidth = chartContainer.node().getBoundingClientRect().width - 16; // Account for padding
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
    function calculateTwilightTimes(astronomicalDayStr) {
        try {
            // Create observer object for Cerro Pachón
            const observer = new Astronomy.Observer(CERRO_PACHON_LAT, CERRO_PACHON_LON, CERRO_PACHON_ELEVATION);

            const dayStart = dayNoon(astronomicalDayStr);
            const dayEnd = new Date(dayStart.getTime() + 24 * HOUR_MS);

            const events = [];

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
                    console.warn(`Could not find ${twilight.name} for ${astronomicalDayStr}:`, e.message);
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
    function createTwilightBackground(astronomicalDayStr) {
        const events = calculateTwilightTimes(astronomicalDayStr);
        const backgrounds = [];

        // Define background colors for different periods
        const colors = {
            day: { color: '#ffffe0', opacity: 0.3 },           // Light yellow
            civil: { color: '#ffa500', opacity: 0.15 },        // Orange
            nautical: { color: '#4169e1', opacity: 0.2 },      // Royal blue
            astronomical: { color: '#191970', opacity: 0.25 }, // Midnight blue
            night: { color: '#1a1a2e', opacity: 0.3 }          // Very dark blue
        };

        // Start with day since the observing day begins around local noon
        let currentMinutes = 0;
        let currentState = 'day';

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
    function calculateMoonTimes(astronomicalDayStr) {
        try {
            // Create observer object for Cerro Pachón
            const observer = new Astronomy.Observer(CERRO_PACHON_LAT, CERRO_PACHON_LON, CERRO_PACHON_ELEVATION);

            const dayStart = dayNoon(astronomicalDayStr);
            const dayEnd = new Date(dayStart.getTime() + 24 * HOUR_MS);

            let moonrise = null;
            let moonset = null;

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
                console.warn(`Could not find moon rise/set for ${astronomicalDayStr}:`, e.message);
            }

            return { moonrise, moonset };

        } catch (error) {
            console.error(`Error calculating moon times for ${astronomicalDayStr}:`, error);
            return null;
        }
    }

    // Scrolling: the SPA scrolls its content pane, not the window.
    const scroller = root.closest(".app-content") || null;
    function scrollTo(top) {
        const target = scroller || window;
        // jsdom (tests) has no scrollTo; a missing one is not worth an error.
        if (typeof target.scrollTo !== "function") return;
        try {
            target.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        } catch {
            /* not scrollable here */
        }
    }
    function scrollToCenter(element) {
        if (!element) return;
        const rect = element.getBoundingClientRect();
        if (scroller) {
            const box = scroller.getBoundingClientRect();
            scrollTo(rect.top - box.top + scroller.scrollTop - box.height / 2);
        } else {
            scrollTo(rect.top + window.pageYOffset - window.innerHeight / 2);
        }
    }

    // Tooltip (fixed to the viewport, so it works inside a scrolling pane)
    const tooltip = d3.select(document.body)
                      .append("div")
                      .attr("class", "guide-tooltip");
    disposers.push(() => tooltip.remove());

    // Selection state
    let selectedBlock = null;
    let highlightedProgram = null;

    // Info panel elements
    const infoPanel = rootSel.select(".guide-info-panel");
    const panelTitle = rootSel.select(".guide-panel-title");
    const panelContent = rootSel.select(".guide-panel-content");

    const PLACEHOLDER = `<div class="guide-info-placeholder">
            Click on a block for details or double-click to view all program versions. Use the search box to find specific programs.
        </div>`;

    // Initialize info panel with placeholder content
    function initializeInfoPanel() {
        infoPanel.classed("empty", true);
        panelTitle.text("Selection Info");
        panelContent.html(PLACEHOLDER);
    }

    // Check if search is currently active
    function isSearchActive() {
        return searchResults.style("display") !== "none";
    }

    // Find the next/previous block for keyboard navigation
    function findAdjacentBlock(direction) {
        if (!selectedBlock || highlightedProgram) {
            return null; // Only navigate when exactly one block is selected
        }

        // Find the currently selected block in the data array
        const currentIndex = data.findIndex(d =>
            (d.originalBlock || d) === selectedBlock
        );

        if (currentIndex === -1) return null;

        // Find adjacent block based on direction
        let targetIndex = -1;

        if (direction === 'up' || direction === 'down') {
            // Navigate vertically (different days)
            const currentDay = data[currentIndex].day;
            const currentX = data[currentIndex].x0;

            // Find blocks on other days at similar time positions
            const otherDayBlocks = data
                .map((d, i) => ({ data: d, index: i }))
                .filter(({ data: d }) => d.day !== currentDay)
                .sort((a, b) => {
                    const dayDiff = direction === 'up' ?
                        a.data.day.localeCompare(currentDay) :
                        b.data.day.localeCompare(currentDay);
                    if (dayDiff !== 0) return dayDiff;

                    // Secondary sort by time proximity
                    return Math.abs(a.data.x0 - currentX) - Math.abs(b.data.x0 - currentX);
                });

            if (otherDayBlocks.length > 0) {
                const targetDayBlocks = otherDayBlocks.filter(({ data: d }) =>
                    d.day === otherDayBlocks[0].data.day
                );

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
    function navigateToBlock(targetBlock) {
        if (!targetBlock) return;

        // Clear current selection
        clearSelection();

        // Select the new block
        selectedBlock = targetBlock.originalBlock || targetBlock;

        // Highlight the block visually
        const targetBlocks = g.selectAll(".block")
            .classed("selected", blockData => blockData.blockId === targetBlock.blockId);

        // Add flash animation
        targetBlocks
            .filter(blockData => blockData.blockId === targetBlock.blockId)
            .classed("flash", true);

        // Show info panel
        showSingleBlockInfo(targetBlock);

        // Scroll to the block
        scrollToCenter(targetBlocks.node());
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

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // The seq range as a link into the camera table (an addition over the
    // original, which showed it as plain text).
    function renderRange(d, day) {
        const text = `${d.seq_num_0} - ${d.seq_num_1}`;
        const href = rangeHref ? rangeHref(d, day) : null;
        if (!href) return text;
        return `<a href="${escapeHtml(href)}" data-internal="1" title="Open these exposures in the camera table">${text}</a>`;
    }

    function renderLinks(d, day) {
        const items = (links ? links(d, day) : []).map(l =>
            `<a href="${escapeHtml(l.href)}"${l.internal ? ' data-internal="1"' : ' target="_blank" rel="noopener noreferrer"'}>${escapeHtml(l.label)}</a>`
        );
        if (items.length === 0) return '';
        return `
            <div class="info-item">
                <div class="info-label">Links:</div>
                <div>${items.join('<br>')}</div>
            </div>`;
    }

    // Functions for info panels
    function showSingleBlockInfo(d) {
        // For spanning blocks, use original block's times; otherwise use the data object's times
        const originalBlock = d.originalBlock || d;
        const durationH = originalBlock.durationH || (originalBlock.end - originalBlock.begin) / HOUR_MS;

        // Get description from translation table if available
        const description = getDescription(d.program);

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
                <div class="info-label">Observation Day:</div>
                <div>${d.day}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Sequence Range:</div>
                <div>${renderRange(d, d.day)}</div>
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
        `);
        showInfoPanel();
    }

    function showProgramInfo(program) {
        // Filter blocks by base program name to include all versions
        // Use original blocks to avoid counting spanning parts multiple times
        const programBlocks = data
            .filter(d => getBaseBlockName(d.program) === program)
            .map(d => d.originalBlock || d); // Get original block if this is a spanning part

        // Remove duplicates (since spanning blocks appear multiple times in data)
        const uniqueBlocks = Array.from(new Set(programBlocks));

        // Calculate total duration, handling cases where durationH might not be present
        const totalDuration = uniqueBlocks.reduce((sum, d) => {
            const duration = d.durationH || (d.end - d.begin) / HOUR_MS;
            return sum + duration;
        }, 0);
        const blockCount = uniqueBlocks.length;

        // Get all unique versions for display
        const versions = Array.from(new Set(uniqueBlocks.map(d => d.program))).sort();

        // Get date range from data blocks (which have the day property), not original blocks
        const programDataBlocks = data
            .filter(d => getBaseBlockName(d.program) === program && !d.isSpanningPart) // Only non-spanning parts to avoid duplicates
            .sort((a, b) => a.day.localeCompare(b.day));

        // Get description for the program (with BLOCK-T mapping)
        const description = getDescription(program);

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
                <div class="info-label">Individual Blocks:</div>
                <div class="guide-block-list">
                    ${uniqueBlocks
                        .sort((a, b) => {
                            const dayA = a.originalBlock ? getAstronomicalDay(a.originalBlock.begin) : a.day;
                            const dayB = b.originalBlock ? getAstronomicalDay(b.originalBlock.begin) : b.day;
                            const dayCompare = dayA.localeCompare(dayB);
                            if (dayCompare !== 0) return dayCompare;
                            return a.seq_num_0 - b.seq_num_0;
                        })
                        .map(d => {
                            const duration = d.durationH || (d.end - d.begin) / HOUR_MS;
                            const day = d.originalBlock ? getAstronomicalDay(d.originalBlock.begin) : d.day;
                            return `<div class="guide-block-item" data-block-id="${d.blockId}" data-day="${day}">
                                <div><strong>${escapeHtml(d.program)}</strong></div>
                                <div class="info-muted">${day} | Seq: ${d.seq_num_0}-${d.seq_num_1} | ${duration.toFixed(2)}h</div>
                            </div>`;
                        })
                        .join('')}
                </div>
            </div>
        `);
        showInfoPanel();
    }

    // Function to select a block by its blockId (from the program summary list)
    function selectBlockById(blockId, day) {
        // Find the block with this blockId in the data array, preferring the one on the specified day
        let blockData;
        if (day) {
            blockData = data.find(d => d.blockId === blockId && d.day === day);
        }
        if (!blockData) {
            blockData = data.find(d => d.blockId === blockId);
        }
        if (!blockData) return;

        // Don't change the program summary view, just scroll to and flash the block
        g.selectAll(".block").classed("flash", false);

        // Find and flash the blocks with this blockId
        const selectedBlocks = g.selectAll(".block")
            .filter(d => d.blockId === blockId);

        selectedBlocks.classed("flash", true);

        // Scroll to the block on the specific day if provided
        let blockElement;
        if (day) {
            blockElement = selectedBlocks.nodes().find(n => d3.select(n).datum().day === day);
        }
        if (!blockElement) {
            blockElement = selectedBlocks.node();
        }

        scrollToCenter(blockElement);
    }

    // Delegated clicks inside the panel: program-summary rows and in-app links.
    panelContent.on("click", function(event) {
        const item = event.target.closest(".guide-block-item");
        if (item) {
            selectBlockById(Number(item.dataset.blockId), item.dataset.day);
            return;
        }
        const link = event.target.closest("a[data-internal]");
        if (link && onNavigate) {
            event.preventDefault();
            onNavigate(link.getAttribute("href"));
        }
    });

    function clearSelection() {
        selectedBlock = null;
        highlightedProgram = null;
        g.selectAll(".block")
            .classed("selected", false)
            .classed("highlighted", false)
            .classed("flash", false);
        hideInfoPanel();
    }

    // Search functionality
    const searchInput = rootSel.select(".guide-search-input");
    const searchResults = rootSel.select(".guide-search-results");
    let selectedSearchIndex = -1; // Track which search result is selected
    let currentSearchResults = []; // Store current search results for navigation

    // Simple fuzzy matching function
    function fuzzyMatch(pattern, text) {
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

    function performSearch(query) {
        if (query.length === 0) {
            searchResults.style("display", "none");
            return;
        }

        // Get all unique full program names (including versions) from the data
        const allProgramNames = Array.from(new Set(data.map(d => d.program)));

        // Create a map from base program to all its versions
        const programVersions = {};
        allProgramNames.forEach(fullProgram => {
            const baseProgram = getBaseBlockName(fullProgram);
            if (!programVersions[baseProgram]) {
                programVersions[baseProgram] = [];
            }
            programVersions[baseProgram].push(fullProgram);
        });

        // Search across base programs and their versions
        const rankedPrograms = programs
            .map(program => {
                let bestMatch = { score: 0, matched: false };
                let matchingVersions = [];

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

                // Also search against descriptive title if available (with BLOCK-T mapping)
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
            .selectAll(".search-result-item")
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
            .classed("search-highlighted", (d, i) => i === selectedSearchIndex)
            .on("click", function(event, d) {
                selectProgram(d.program);
                searchInput.node().value = "";
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
            .classed("search-highlighted", (d, i) => i === selectedSearchIndex);

        // Scroll the selected item into view
        if (selectedSearchIndex >= 0) {
            const selectedElement = searchResults.selectAll(".search-result-item").nodes()[selectedSearchIndex];
            if (selectedElement && selectedElement.scrollIntoView) {
                selectedElement.scrollIntoView({
                    behavior: 'smooth',
                    block: 'nearest'
                });
            }
        }
    }

    function selectProgram(program) {
        clearSelection();
        const baseProgram = getBaseBlockName(program);

        // Find all blocks for this program
        const programBlocks = data.filter(d => getBaseBlockName(d.program) === baseProgram);

        if (programBlocks.length === 1) {
            // Exactly one block - show block information instead of program summary
            const singleBlock = programBlocks[0];
            selectedBlock = singleBlock.originalBlock || singleBlock;

            // Highlight just this single block
            const selectedBlocks = g.selectAll(".block")
                .classed("selected", blockData => blockData.blockId === singleBlock.blockId);

            // Add flash animation to selected block
            selectedBlocks
                .filter(blockData => blockData.blockId === singleBlock.blockId)
                .classed("flash", true);

            showSingleBlockInfo(singleBlock);

            scrollToCenter(selectedBlocks.node());
        } else {
            // Multiple blocks - show program summary as before
            highlightedProgram = baseProgram;

            // Highlight all blocks with the same base program (including versions)
            const highlightedBlocks = g.selectAll(".block")
                .classed("highlighted", blockData => getBaseBlockName(blockData.program) === baseProgram);

            // Add flash animation to highlighted blocks
            highlightedBlocks
                .filter(blockData => getBaseBlockName(blockData.program) === baseProgram)
                .classed("flash", true);

            showProgramInfo(baseProgram);

            // Scroll to the first block of this program
            const firstBlock = data.find(d => getBaseBlockName(d.program) === baseProgram);
            if (firstBlock) {
                const blockElement = g.selectAll(".block")
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

    searchInput.on("keydown", function(event) {
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
    const onDocumentClick = (event) => {
        if (!event.target.closest(".guide-search-container")) {
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
    const floatingAxisSvg = rootSel.select(".guide-floating-axis-svg");
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
        const chartLeft = svg.node().getBoundingClientRect().left;
        const axisLeft = floatingAxisSvg.node().getBoundingClientRect().left;
        const shift = Math.round(chartLeft - axisLeft);
        floatingAxisSvg.attr("width", width + Math.max(0, shift));
        floatingG.attr("transform", `translate(${margin.left + shift},15)`);
    }
    alignFloatingAxis();
    window.addEventListener("resize", alignFloatingAxis);
    disposers.push(() => window.removeEventListener("resize", alignFloatingAxis));

    // Determine which Chilean timezone is currently active
    // Chile uses CLST (UTC-3) from second Saturday of September to first Saturday of April
    // and CLT (UTC-4) the rest of the year
    function isChileSummerTime(date) {
        const year = date.getFullYear();
        const month = date.getMonth(); // 0-11

        // Approximate: CLST is roughly September-March (southern hemisphere summer)
        // More precisely: second Saturday September to first Saturday April
        if (month >= 8 && month <= 11) return true;  // Sep-Dec
        if (month >= 0 && month <= 2) return true;   // Jan-Mar
        if (month === 3) {
            // April - need to check if before first Saturday
            const firstDay = new Date(year, 3, 1);
            const firstSaturday = 1 + (6 - firstDay.getDay() + 7) % 7;
            return date.getDate() < firstSaturday;
        }
        if (month === 8) {
            // September - need to check if after second Saturday
            const firstDay = new Date(year, 8, 1);
            const firstSaturday = 1 + (6 - firstDay.getDay() + 7) % 7;
            const secondSaturday = firstSaturday + 7;
            return date.getDate() >= secondSaturday;
        }
        return false; // April-August (except transition days)
    }

    const currentDate = new Date();
    const isSummerTime = isChileSummerTime(currentDate);
    const cltOpacity = isSummerTime ? 0.3 : 1.0;
    const clstOpacity = isSummerTime ? 1.0 : 0.3;

    // Hours since the day boundary -> clock hour in a zone `offset` hours from UTC
    function clockLabel(d, offset) {
        let hour = (d + DAY_START + offset) % 24;
        if (hour < 0) hour += 24;
        return hour.toString().padStart(2, '0') + ":00";
    }

    function addAxis(yOffset, offset, cls, opacity) {
        const axis = d3.axisBottom(x)
                       .tickFormat(d => clockLabel(d, offset))
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
                        .tickFormat("")
                        .tickSize(3);
        floatingG.append("g")
            .attr("class", "x-axis-minor")
            .attr("transform", `translate(0,${yOffset})`)
            .style("opacity", opacity)
            .call(minor);
    }

    function addAxisLabel(yOffset, text, opacity) {
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
                .attr("y", y(day))
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
                .attr("y1", y(day) - 1)
                .attr("y2", y(day) - 1)
                .attr("stroke-width", 1.5)
                .style("pointer-events", "none");
        }
    });

    // Draw moon overlays
    days.forEach(day => {
        const moonTimes = calculateMoonTimes(day);

        if (moonTimes && (moonTimes.moonrise || moonTimes.moonset)) {
            // Determine the period when the moon is visible (above horizon)
            let moonVisibleStart = null;
            let moonVisibleEnd = null;

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
                        .attr("y", y(day))
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
                    .attr("y", y(day))
                    .attr("width", x(moonVisibleEnd) - x(moonVisibleStart))
                    .attr("height", y.bandwidth())
                    .attr("fill", "#b3d9ff")  // More saturated blue
                    .attr("opacity", 0.4)     // Nice balance of visibility
                    .style("pointer-events", "none"); // Don't interfere with block interactions
            }
        }
    });

    // Draw Blocks
    g.selectAll("rect.block")
        .data(data)
        .join("rect")
            .attr("class", "block")
            .attr("x", d => x(d.x0))
            .attr("y", d => y(d.day))
            .attr("width", d => x(d.x1) - x(d.x0))
            .attr("height", y.bandwidth())
            .attr("fill", d => color(getBaseBlockName(d.program)))
            .attr("fill-opacity", 0.9)
            .attr("stroke", "#333")
            .attr("stroke-width", 0.5)
            .on("click", function(event, d) {
                event.stopPropagation();
                clearSelection();
                selectedBlock = d.originalBlock || d; // Use original block for spanning parts

                // Highlight all parts of this block (for spanning blocks)
                const selectedBlocks = g.selectAll(".block")
                    .classed("selected", blockData => blockData.blockId === d.blockId);

                // Add flash animation to selected blocks
                selectedBlocks
                    .filter(blockData => blockData.blockId === d.blockId)
                    .classed("flash", true);

                showSingleBlockInfo(d); // Always pass the clicked data object, not original
            })
            .on("dblclick", function(event, d) {
                event.stopPropagation();
                clearSelection();

                // Get the base block name to select all versions
                const baseBlockName = getBaseBlockName(d.program);
                highlightedProgram = baseBlockName;

                // Highlight all blocks with the same base program (all versions)
                const highlightedBlocks = g.selectAll(".block")
                    .classed("highlighted", blockData => getBaseBlockName(blockData.program) === baseBlockName);

                // Add flash animation to highlighted blocks
                highlightedBlocks
                    .filter(blockData => getBaseBlockName(blockData.program) === baseBlockName)
                    .classed("flash", true);

                showProgramInfo(baseBlockName);
            })
            .on("mouseenter", function(event, d) {
                const originalBlock = d.originalBlock || d;
                const durationH = originalBlock.durationH || (originalBlock.end - originalBlock.begin) / HOUR_MS;
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
            .on("mousemove", (event) => {
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
    const onKeydown = (event) => {
        // Don't trigger if user is already typing in the search box or other input
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
            return;
        }

        if (event.key === "/" || (event.ctrlKey && event.key === "f")) {
            event.preventDefault();
            searchInput.node().focus();
        } else if (!isSearchActive() && selectedBlock && !highlightedProgram) {
            // Arrow key navigation when exactly one block is selected and search is closed
            let targetBlock = null;

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
            }

            if (targetBlock) {
                navigateToBlock(targetBlock);
            }
        }
    };
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
