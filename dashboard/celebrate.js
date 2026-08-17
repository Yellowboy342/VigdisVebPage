/* Vigdís web dashboard — the completion moment.
 *
 * The app spends real effort on what happens the instant a task is
 * ticked: the points fly from the row to the balance pill, Lóa pops up
 * cheering, and confetti fires if the profile wants it. That sequence
 * is the reinforcement loop the whole product is built on — it is why
 * a child taps the circle a second time tomorrow.
 *
 * The website had a 200ms pulse on a number. Same data, none of the
 * feeling. This module ports the three beats that matter, using the
 * same rules the app uses (confetti follows `show_confetti`, and
 * everything yields to prefers-reduced-motion).
 *
 * Deliberately DOM + CSS rather than canvas. The whole sequence is
 * about twenty elements alive for under a second; a canvas would mean
 * a render loop running for the life of the page to serve an event
 * that happens a few times an hour.
 */

const REDUCED = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

/** Elements we injected, so a profile switch mid-flight can clear them
 *  rather than leaving a "+10" hanging over a different child's list. */
let inFlight = [];

function track(el, lifetimeMs) {
    inFlight.push(el);
    setTimeout(() => {
        el.remove();
        inFlight = inFlight.filter((e) => e !== el);
    }, lifetimeMs);
}

export function clearCelebrations() {
    inFlight.forEach((el) => el.remove());
    inFlight = [];
}

/* ── Points fly ────────────────────────────────────────
 *
 * The badge travels from the row to the balance pill on a slight arc.
 * The arc is the point: a straight line reads as a UI element being
 * repositioned, a curve reads as something being thrown. The app's
 * version does the same.
 */
export function flyPoints({ from, to, points }) {
    if (!from || !to || !points) return;
    if (REDUCED.matches) { pulse(to); return; }

    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();

    const badge = document.createElement('div');
    badge.className = 'fly-points';
    badge.textContent = `+${points}`;
    badge.setAttribute('aria-hidden', 'true');
    badge.style.left = `${a.left + a.width / 2}px`;
    badge.style.top = `${a.top + a.height / 2}px`;

    /* Travel as CSS custom properties so the keyframes stay static and
       the browser can composite the whole thing on the GPU. */
    badge.style.setProperty('--dx', `${b.left + b.width / 2 - (a.left + a.width / 2)}px`);
    badge.style.setProperty('--dy', `${b.top + b.height / 2 - (a.top + a.height / 2)}px`);
    /* Lift the apex for longer throws, so a badge crossing the whole
       page arcs more than one moving a few rows. */
    badge.style.setProperty('--lift', `${Math.min(90, Math.abs(b.top - a.top) * 0.35 + 30)}px`);

    document.body.appendChild(badge);
    /* Pulse the pill as the badge lands, not when it leaves — the
       number growing at the moment of arrival is what sells the throw
       as having delivered something. */
    setTimeout(() => pulse(to), 620);
    track(badge, 900);
}

function pulse(el) {
    el.classList.remove('balance-pulse');
    // Reflow, or re-adding the class in the same frame does nothing.
    void el.offsetWidth;
    el.classList.add('balance-pulse');
}

/* ── Lóa ───────────────────────────────────────────────
 *
 * She pops in beside the row that was just completed, bounces once and
 * fades. In the app this is the piece that reads as praise rather than
 * feedback — a number going up is information, a character reacting is
 * someone noticing.
 */
export function cheerAt(anchor) {
    if (!anchor || REDUCED.matches) return;
    const r = anchor.getBoundingClientRect();

    const loa = document.createElement('img');
    loa.className = 'cheer-loa';
    loa.src = '../assets/mascot/loa-celebrating.svg';
    loa.alt = '';
    loa.setAttribute('aria-hidden', 'true');
    /* Just outside the row's right edge, clamped so she never lands
       off-screen on a narrow window. */
    loa.style.left = `${Math.min(r.right - 56, window.innerWidth - 76)}px`;
    loa.style.top = `${r.top + r.height / 2 - 30}px`;

    document.body.appendChild(loa);
    track(loa, 1400);
}

/* ── Confetti ──────────────────────────────────────────
 *
 * Gated on the profile's `show_confetti`, exactly as the app gates it.
 * That column exists because confetti is genuinely wrong for some
 * children — a web version that ignored it would undo a deliberate
 * accommodation a parent made.
 */
const CONFETTI_PIECES = 26;

export function confettiBurst({ enabled = true } = {}) {
    if (!enabled || REDUCED.matches) return;

    const layer = document.createElement('div');
    layer.className = 'confetti-layer';
    layer.setAttribute('aria-hidden', 'true');

    for (let i = 0; i < CONFETTI_PIECES; i += 1) {
        const piece = document.createElement('i');
        /* Spread across the top, drifting down and sideways. Values are
           per-piece so the burst never looks like a repeating pattern. */
        piece.style.setProperty('--x', `${Math.random() * 100}%`);
        piece.style.setProperty('--drift', `${(Math.random() - 0.5) * 240}px`);
        piece.style.setProperty('--spin', `${Math.random() * 720 - 360}deg`);
        piece.style.setProperty('--delay', `${Math.random() * 220}ms`);
        piece.style.setProperty('--fall', `${900 + Math.random() * 700}ms`);
        piece.style.setProperty('--size', `${6 + Math.random() * 6}px`);
        /* Tint from the live theme tokens, so confetti in Ocean is blue.
           Index picks between the accent and its two derived tones. */
        piece.style.setProperty('--tint', ['var(--coral)', 'var(--coral-deep)', 'var(--done-green)'][i % 3]);
        layer.appendChild(piece);
    }

    document.body.appendChild(layer);
    track(layer, 2000);
}

/* ── The whole sequence ────────────────────────────────
 *
 * One call so the caller does not have to know the choreography or its
 * timings. Only fires on completion, never on un-completing: taking a
 * tick back is a correction, and celebrating it would be the app
 * cheering someone for undoing their work.
 */
export function celebrateCompletion({ rowEl, pillEl, points, showConfetti }) {
    flyPoints({ from: rowEl, to: pillEl, points });
    cheerAt(rowEl);
    confettiBurst({ enabled: showConfetti });
}
