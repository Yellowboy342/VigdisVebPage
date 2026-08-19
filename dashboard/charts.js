/* Vigdís web dashboard — charts.
 *
 * Statistics was three numbers and a stack of identical bars. It read
 * as a report rather than as something you would look at twice, and it
 * answered "how many" without ever answering "is this getting better",
 * which is the only question a parent actually has.
 *
 * Inline SVG, no library. The site is static with no build step, so a
 * charting dependency would mean a CDN script on a page that already
 * loads one; and these are three chart types over at most ninety
 * points, which is squarely in the range where hand-written paths are
 * smaller and faster than anything generic.
 *
 * Everything draws from CSS custom properties, so charts follow the
 * profile's theme and light/dark exactly like the rest of the page.
 *
 * Every function here must survive the degenerate cases, because a new
 * profile hits all of them at once: no data, one data point, every
 * value identical, and a single day of history. A chart that renders a
 * broken axis on day one is worse than a sentence saying "not yet".
 */

const NS = 'http://www.w3.org/2000/svg';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/** Catmull-Rom to cubic Bézier. A polyline reads as data plotted; a
 *  gentle curve reads as a trend, which is what this chart is for.
 *  Tension stays low so the curve never overshoots into implying a
 *  value that was not recorded. */
function smoothPath(points) {
    if (points.length < 2) return '';
    let d = `M${points[0][0]},${points[0][1]}`;
    for (let i = 0; i < points.length - 1; i += 1) {
        const p0 = points[i - 1] || points[i];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] || p2;
        const t = 0.18;
        d += ` C${p1[0] + (p2[0] - p0[0]) * t},${p1[1] + (p2[1] - p0[1]) * t}`
           + ` ${p2[0] - (p3[0] - p1[0]) * t},${p2[1] - (p3[1] - p1[1]) * t}`
           + ` ${p2[0]},${p2[1]}`;
    }
    return d;
}

function emptyState(message) {
    return `<p class="chart-empty">${esc(message)}</p>`;
}

/* ── Trend ─────────────────────────────────────────────
 *
 * Completions per day across the window. The headline chart: it is the
 * one that shows a routine taking hold, or slipping, which no table of
 * totals can.
 */
export function trendChart(series, { label = 'Steps completed', average = null } = {}) {
    if (!series.length) return emptyState('No history in this range yet.');

    /* The viewBox used to be 720×190 with `preserveAspectRatio="none"`,
       which stretched every stroke and turned the dots into ellipses on
       a wide screen — the chart was drawn at one aspect and displayed at
       another. It scales proportionally now, and the box is wide enough
       that the labels inside it land near their nominal size at the
       width this actually renders at. */
    const W = 1200;
    const H = 250;
    const padL = 0;
    const padR = 0;
    const padTop = 14;
    const padBottom = 14;

    const max = Math.max(1, ...series.map((d) => d.value));
    const innerW = W - padL - padR;
    const innerH = H - padTop - padBottom;

    /* Round the top of the scale up to a readable step (1, 2, 5, 10 …)
       rather than ending on the raw maximum. Ticks of 0-2-4-5 put two
       gridlines a few pixels apart at the top of the chart and read as
       a rendering fault. */
    const rawStep = max / 4;
    const pow = 10 ** Math.floor(Math.log10(rawStep || 1));
    const n = rawStep / pow;
    const step = Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow);
    const top = Math.ceil(max / step) * step;

    /* One point cannot make a line. Centre it and draw a dot, rather
       than dividing by zero and emitting NaN into the path. */
    const stepX = series.length > 1 ? innerW / (series.length - 1) : 0;
    const x = (i) => (series.length > 1 ? padL + i * stepX : padL + innerW / 2);
    const y = (v) => padTop + innerH - (v / top) * innerH;

    const points = series.map((d, i) => [x(i), y(d.value)]);
    const line = smoothPath(points);
    const area = points.length > 1
        ? `${line} L${points[points.length - 1][0]},${padTop + innerH} L${points[0][0]},${padTop + innerH} Z`
        : '';

    /* Gridlines carry their value now. "Peak 5" in the corner told you
       the ceiling and nothing else, so a hump in the middle of the chart
       could be a 4 or a 1 — the shape was readable and the scale was
       not. Whole numbers only; half a completed task is not a thing
       that exists. */
    const ticks = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);

    const grid = ticks.map((v) => `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}"
        class="chart-grid"/>`).join('');

    /* The scale labels are HTML, positioned down the gutter as a
       percentage of the plot's height. Inside the SVG they were sized in
       viewBox units, so they shrank with the container — 13px specified,
       about 7px rendered in a narrow window. A percentage survives any
       width because the box scales proportionally. */
    const yLabels = ticks.map((v) => `<span class="chart__ylab"
        style="top:${(y(v) / H) * 100}%">${v}</span>`).join('');

    /* A dot per day is signal at 30 points and noise at 90. */
    const dots = series.length <= 32
        ? points.map(([px, py], i) => `<circle cx="${px}" cy="${py}" r="${series.length > 1 ? 3 : 5}"
            class="chart-dot"><title>${esc(series[i].label)}: ${series[i].value}</title></circle>`).join('')
        : '';

    /* The rolling average is the actual answer to "is this getting
       better" — the daily line is too spiky to tell, especially for a
       routine that runs on weekdays and stops at the weekend. */
    const avgPath = average && average.length === series.length
        ? smoothPath(average.map((v, i) => [x(i), y(v)]))
        : '';

    /* Mark the best day. One labelled point turns a shape into a fact
       you can repeat to someone. */
    const peakIdx = series.reduce((best, d, i) => (d.value > series[best].value ? i : best), 0);
    const peakMark = series[peakIdx].value > 0 ? `
        <circle cx="${x(peakIdx)}" cy="${y(series[peakIdx].value)}" r="5" class="chart-dot is-peak"/>
        <title>${esc(series[peakIdx].label)}: ${series[peakIdx].value}</title>` : '';

    const first = series[0].label;
    const mid = series[Math.floor((series.length - 1) / 2)].label;
    const last = series[series.length - 1].label;

    return `
    <figure class="chart">
        ${label || avgPath ? `<figcaption class="chart__cap">
            <span>${esc(label)}</span>
            ${avgPath ? '<span class="chart__key"><i class="chart__key-line"></i>7-day average</span>' : ''}
        </figcaption>` : ''}
        <div class="chart__plot">
        ${yLabels}
        <svg viewBox="0 0 ${W} ${H}" role="img"
             aria-label="${esc(label)} per day, peak ${max} on ${esc(series[peakIdx].label)}">
            <defs>
                <linearGradient id="trend-fill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" class="chart-fill-top"/>
                    <stop offset="100%" class="chart-fill-bottom"/>
                </linearGradient>
            </defs>
            ${grid}
            ${area ? `<path d="${area}" fill="url(#trend-fill)"/>` : ''}
            ${line ? `<path d="${line}" class="chart-line"/>` : ''}
            ${avgPath ? `<path d="${avgPath}" class="chart-line is-average"/>` : ''}
            ${dots}
            ${peakMark}
        </svg>
        </div>
        <div class="chart__axis">
            <span>${esc(first)}</span><span>${esc(mid)}</span><span>${esc(last)}</span>
        </div>
    </figure>`;
}

/* ── Categorical bars ──────────────────────────────────
 *
 * Used for weekday and time-of-day. Both answer "when does this family
 * actually manage it", which is the question that changes what a parent
 * does next — a routine failing every Thursday is a scheduling problem,
 * not a motivation one.
 */
export function barChart(rows, { label = '', highlightMax = true } = {}) {
    if (!rows.length || rows.every((r) => !r.value)) {
        return emptyState('Nothing recorded in this range yet.');
    }

    /* Built from divs, not SVG. The old version drew its labels inside a
       720-wide viewBox and then displayed that box at about 360px in a
       two-up grid, so every tick rendered at roughly half the size it
       was specified at — the text on this screen was smaller than
       anything else on the page for no reason anyone chose. HTML text
       is HTML text at whatever width the column ends up. */
    const max = Math.max(1, ...rows.map((r) => r.value));
    const peak = rows.reduce((m, r) => (r.value > m ? r.value : m), 0);

    const cols = rows.map((r) => {
        const isPeak = highlightMax && r.value === peak && peak > 0;
        const h = r.value ? Math.max(6, Math.round((r.value / max) * 100)) : 0;
        return `
        <div class="colchart__col" title="${esc(r.label)}: ${r.value}">
            <span class="colchart__n${r.value ? '' : ' is-zero'}">${r.value}</span>
            <div class="colchart__track">
                ${h ? `<div class="colchart__bar${isPeak ? ' is-peak' : ''}" style="height:${h}%"></div>` : ''}
            </div>
            <span class="colchart__label">${esc(r.label)}</span>
        </div>`;
    }).join('');

    return `
    <figure class="chart">
        ${label ? `<figcaption class="chart__cap"><span>${esc(label)}</span></figcaption>` : ''}
        <div class="colchart" role="img"
             aria-label="${esc(label)}: ${esc(rows.map((r) => `${r.label} ${r.value}`).join(', '))}">
            ${cols}
        </div>
    </figure>`;
}

/* ── Ranked horizontal bars ────────────────────────────
 *
 * For categories with real names — "After school", "No period" — where
 * a vertical column forces the label to be truncated or turned on its
 * side. Same data, read as a list, which is also how a parent thinks
 * about it: which part of the day carries this routine.
 */
export function rankBars(rows, { label = '', unit = '' } = {}) {
    if (!rows.length || rows.every((r) => !r.value)) {
        return emptyState('Nothing recorded in this range yet.');
    }
    const max = Math.max(1, ...rows.map((r) => r.value));
    const total = rows.reduce((s, r) => s + r.value, 0) || 1;

    return `
    <figure class="chart">
        ${label ? `<figcaption class="chart__cap"><span>${esc(label)}</span></figcaption>` : ''}
        <ul class="rankbars" role="img"
            aria-label="${esc(label)}: ${esc(rows.map((r) => `${r.label} ${r.value}`).join(', '))}">
            ${rows.map((r, i) => `
            <li class="rankbar">
                <span class="rankbar__label">${esc(r.label)}</span>
                <span class="rankbar__track">
                    <span class="rankbar__fill${i === 0 ? ' is-peak' : ''}"
                          style="width:${Math.max(2, Math.round((r.value / max) * 100))}%"></span>
                </span>
                <span class="rankbar__n">${r.value}${unit ? `<small>${esc(unit)}</small>` : ''}
                    <small>${Math.round((r.value / total) * 100)}%</small></span>
            </li>`).join('')}
        </ul>
    </figure>`;
}

/* ── Reliability ───────────────────────────────────────
 *
 * The per-task list, kept as a list — ranking is what matters here and
 * a bar chart of twenty tasks is a wall. Restyled so the bar reads as a
 * track being filled rather than as another flat rule, and so a 0%
 * still shows its empty track instead of vanishing.
 */
export function reliabilityRows(rows) {
    if (!rows.length) return emptyState('Nothing recorded yet.');
    return `<ul class="rel-list">${rows.map((t) => {
        const pct = Math.round(t.rate * 100);
        /* Colour by band, not by a gradient: a parent needs "this one
           is slipping", not a hue they have to decode. */
        const band = pct >= 80 ? 'is-good' : pct >= 50 ? 'is-mid' : 'is-low';
        return `<li class="rel-row">
            <span class="rel-row__title">${esc(t.title)}</span>
            <span class="rel-row__track"><span class="rel-row__fill ${band}" style="width:${pct}%"></span></span>
            <span class="rel-row__pct">${pct}%<small>${t.done}/${t.due}</small></span>
        </li>`;
    }).join('')}</ul>`;
}
