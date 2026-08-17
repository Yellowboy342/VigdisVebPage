/* Vigdís web dashboard — talks to the same Supabase backend as the iOS app.
 * The publishable key below is client-safe: every table is protected by
 * row-level security, so a signed-in user can only reach their own profiles. */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
/* Setup/management lives in its own module — see manage.js for why it
   is not appended to this file. It receives its dependencies through
   initManagement rather than importing back from here, which would
   make a cycle. */
import {
    initManagement, loadEntitlement, renderManagement, renderTaskSteps,
    setProfileReloader, setRecurrence, readRecurrence, loadReadOnlyExtras,
    refreshShares, loadReferralCode, applyProfileTheme,
} from './manage.js';
/* The completion moment — points fly, Lóa cheers, confetti. */
import { celebrateCompletion, clearCelebrations } from './celebrate.js';

const SUPABASE_URL = 'https://vfdjirmowbjdmieeyjkl.supabase.co';
const SUPABASE_KEY = 'sb_publishable_XxI8jNl0ERoIlLLKdS93_g_cuNyvLy5';
const IMAGE_BUCKET = 'vigdis-images';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ?demo=1 renders the dashboard with sample data and no server writes —
 * useful for previewing the design before signing in. */
const DEMO = new URLSearchParams(location.search).has('demo');

/* Email auth IS enabled on this project — verified against
 * GET /auth/v1/settings, which reports `external.email: true`. The note
 * that used to sit here claiming otherwise was stale, and it was hiding
 * a working sign-in form behind a hardcoded false. */

/* ── State ─────────────────────────────────────────── */

const state = {
    session: null,
    profiles: [],
    activeProfileId: null,
    filter: 'today',
    data: { timePeriods: [], tasks: [], subtasks: [], rewards: [], redemptions: [], bonus: [] },
    channel: null,
    editingTaskId: null,
};

/* ── Tiny helpers ──────────────────────────────────── */

const $ = (sel) => document.querySelector(sel);

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
}

/* The server dedupes completions by UTC day (date_trunc), so day keys are UTC. */
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const todayKey = () => dayKey(new Date());

/* recurrence_days uses Apple Calendar weekdays: 1 = Sunday … 7 = Saturday. */
const appWeekday = (d = new Date()) => d.getDay() + 1;

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isCompletedOn(task, key) {
    return (task.completion_history || []).some((ts) => dayKey(ts) === key);
}

/* The day being looked at. Everything below reads this rather than
   "now", so the dashboard can review any date — the whole point of a
   setup-and-review surface, as opposed to the app, which is for doing
   today. Set to today on load. */
let viewKey = todayKey();
const viewDate = () => new Date(viewKey + 'T12:00:00Z');
const isViewingToday = () => viewKey === todayKey();
/* Completions are stamped at midday UTC when back-dating, so a stored
   timestamp cannot slide into an adjacent day for users either side of
   UTC. Today keeps a real "now" so ordering within today stays honest. */
const stampForView = () => (isViewingToday() ? new Date().toISOString() : viewKey + 'T12:00:00Z');

function isScheduledOn(task, date) {
    const rec = task.recurrence_days;
    if (Array.isArray(rec) && rec.length > 0) return rec.includes(appWeekday(date));
    return true; // one-off tasks stay visible until done
}

function safeColor(hex) {
    return /^#[0-9A-Fa-f]{6}$/.test(hex || '') ? hex : '#F09190';
}

const SYMBOL_EMOJI = {
    'star.fill': '⭐', star: '⭐', clock: '⏰', 'clock.fill': '⏰', timer: '⏱️',
    book: '📚', 'book.fill': '📚', 'list.bullet': '📋', bed: '🛏️', 'bed.double.fill': '🛏️',
    'fork.knife': '🍽️', backpack: '🎒', 'backpack.fill': '🎒', tshirt: '👕', 'tshirt.fill': '👕',
    sun: '☀️', 'sun.max.fill': '☀️', moon: '🌙', 'moon.fill': '🌙', heart: '❤️', 'heart.fill': '❤️',
};

function iconFor(item) {
    const icon = (item.icon || '').trim();
    if (!icon) return '📝';
    if (/^[a-z0-9.]+$/i.test(icon)) return SYMBOL_EMOJI[icon] || '⭐';
    return icon;
}

function fmtDate(d, opts = { weekday: 'long', month: 'long', day: 'numeric' }) {
    return new Date(d).toLocaleDateString('en-GB', opts);
}

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* Signed URLs for images in the private bucket, cached per path. */
const urlCache = new Map();
async function signedUrl(path) {
    if (!path) return null;
    if (urlCache.has(path)) return urlCache.get(path);
    const { data, error } = await sb.storage.from(IMAGE_BUCKET).createSignedUrl(path, 3600);
    const url = error ? null : data.signedUrl;
    urlCache.set(path, url);
    return url;
}

/* Hydrate <img data-storage-path> elements once their signed URL resolves. */
function hydrateImages(root) {
    root.querySelectorAll('img[data-storage-path]').forEach(async (img) => {
        const url = await signedUrl(img.dataset.storagePath);
        if (url) { img.src = url; img.hidden = false; if (img.nextElementSibling) img.nextElementSibling.hidden = true; }
    });
}

/* ── Toasts ────────────────────────────────────────── */

function toast(message, { actionLabel, onAction, duration = 5000 } = {}) {
    const host = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.innerHTML = `<span class="toast__msg">${esc(message)}</span>`;
    if (actionLabel) {
        const btn = document.createElement('button');
        btn.className = 'toast__action';
        btn.textContent = actionLabel;
        btn.addEventListener('click', () => { onAction?.(); dismiss(); });
        el.appendChild(btn);
    }
    host.appendChild(el);
    let timer = setTimeout(dismiss, duration);
    function dismiss() {
        clearTimeout(timer);
        el.classList.add('is-leaving');
        el.addEventListener('animationend', () => el.remove(), { once: true });
    }
}

/* ── Views ─────────────────────────────────────────── */

function showView(id) {
    ['view-loading', 'view-auth', 'view-recovery', 'view-app'].forEach((v) => {
        document.getElementById(v).hidden = v !== id;
    });
}

/* ── Auth ──────────────────────────────────────────── */

function authRedirectUrl() {
    return location.origin + location.pathname;
}

/* Supabase reports a provider as enabled in /auth/v1/settings as soon as
   its toggle is on, even when it has no client secret configured. Apple
   on the web is exactly that case right now: the toggle is on, the
   secret is missing, and /auth/v1/authorize answers

       400 {"error_code":"validation_failed",
             "msg":"Unsupported provider: missing OAuth secret"}

   Because signInWithOAuth navigates the browser straight at that URL,
   the user's reward for pressing "Continue with Apple" is a page of raw
   JSON. So probe first and only navigate if the provider really answers.

   The probe is a hand-built URL rather than skipBrowserRedirect so it
   doesn't mint a PKCE verifier we're going to throw away. A configured
   provider answers with a cross-origin redirect, which fetch surfaces as
   an opaque response — unreadable, but its very opaqueness is the signal
   that we got a redirect rather than a JSON error. Anything we can't
   classify falls through to navigating, so a probe that breaks for its
   own reasons never blocks a working sign-in.

   Nothing here needs changing once the Apple secret is configured: the
   probe simply starts passing. */
async function providerIsConfigured(provider) {
    const url = `${SUPABASE_URL}/auth/v1/authorize?provider=${encodeURIComponent(provider)}`
        + `&redirect_to=${encodeURIComponent(authRedirectUrl())}`;
    try {
        const res = await fetch(url, { method: 'GET', redirect: 'manual' });
        if (res.type === 'opaqueredirect' || res.status === 0) return true;
        if (res.status === 400) return false;
        return true;
    } catch {
        return true;
    }
}

async function signInWithProvider(provider) {
    const errEl = $('#auth-error');
    errEl.textContent = '';

    const label = provider === 'apple' ? 'Apple' : 'Google';
    if (!(await providerIsConfigured(provider))) {
        errEl.textContent = `${label} sign-in isn’t set up for the website yet. `
            + `Use the email link below — it works with the same account.`;
        return;
    }

    const { error } = await sb.auth.signInWithOAuth({
        provider,
        options: { redirectTo: authRedirectUrl() },
    });
    if (error) errEl.textContent = error.message;
}

function surfaceOAuthError() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const desc = params.get('error_description');
    if (desc) {
        $('#auth-error').textContent = desc.replace(/\+/g, ' ');
        history.replaceState(null, '', location.pathname);
    }
}

/* Which email method the form is currently offering. Starts on the link
   because no account created so far has a password to type. */
let emailMode = 'link';

function setEmailMode(mode) {
    emailMode = mode;
    const usingPassword = mode === 'password';
    $('#field-password').hidden = !usingPassword;
    $('#note-password-toggle').hidden = usingPassword;
    $('#note-forgot').hidden = !usingPassword;
    $('#btn-signin').textContent = usingPassword ? 'Sign in' : 'Email me a sign-in link';
    $('#auth-error').textContent = '';
    if (usingPassword) $('#in-password').focus();
}

async function sendSignInLink(email) {
    const errEl = $('#auth-error');
    const btn = $('#btn-signin');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Sending…';

    /* shouldCreateUser: false because accounts belong to the app. Letting
       the dashboard mint one would produce an account with no profiles,
       nothing to show, and no obvious way to explain why. */
    const { error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: authRedirectUrl(), shouldCreateUser: false },
    });

    btn.disabled = false;
    btn.textContent = 'Email me a sign-in link';

    if (error) {
        errEl.textContent = /signups not allowed|not found/i.test(error.message)
            ? 'No Vigdís account uses that email address. Check the spelling, or create an account in the app first.'
            : error.message;
        return;
    }
    errEl.textContent = '';
    toast(`Sign-in link sent to ${email}. Open it on this device.`, { duration: 8000 });
}

async function signInWithPassword(email, password) {
    const errEl = $('#auth-error');
    const btn = $('#btn-signin');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Signing in…';
    const { error } = await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    btn.textContent = 'Sign in';
    if (error) {
        errEl.textContent = error.message === 'Invalid login credentials'
            ? 'That email and password don’t match an account. If you signed up with Apple or Google you won’t have a password yet — use the emailed link instead.'
            : error.message;
    }
}

function bindAuthUI() {
    $('#btn-apple').addEventListener('click', () => signInWithProvider('apple'));
    $('#btn-google').addEventListener('click', () => signInWithProvider('google'));

    $('#link-use-password').addEventListener('click', (e) => {
        e.preventDefault();
        setEmailMode('password');
    });
    $('#link-use-link').addEventListener('click', (e) => {
        e.preventDefault();
        setEmailMode('link');
    });

    $('#form-email').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = $('#in-email').value.trim();
        const errEl = $('#auth-error');
        errEl.textContent = '';
        if (!email) {
            errEl.textContent = 'Enter your email address.';
            $('#in-email').focus();
            return;
        }
        if (emailMode === 'link') { await sendSignInLink(email); return; }

        const password = $('#in-password').value;
        if (!password) { errEl.textContent = 'Enter your password.'; $('#in-password').focus(); return; }
        await signInWithPassword(email, password);
    });

    $('#link-forgot').addEventListener('click', async (e) => {
        e.preventDefault();
        const email = $('#in-email').value.trim();
        const errEl = $('#auth-error');
        if (!email) {
            errEl.textContent = 'Type your email address above first, then tap “Forgot your password?” again.';
            $('#in-email').focus();
            return;
        }
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: authRedirectUrl() });
        errEl.textContent = '';
        if (error) errEl.textContent = error.message;
        else toast(`Password reset link sent to ${email}.`, { duration: 7000 });
    });

    $('#form-recovery').addEventListener('submit', async (e) => {
        e.preventDefault();
        const password = $('#in-newpass').value;
        const errEl = $('#recovery-error');
        errEl.textContent = '';
        if (password.length < 8) { errEl.textContent = 'The password needs at least 8 characters.'; return; }
        const { error } = await sb.auth.updateUser({ password });
        if (error) { errEl.textContent = error.message; return; }
        toast('Password updated.');
        enterApp();
    });

    $('#btn-signout').addEventListener('click', async () => {
        if (DEMO) { location.href = location.pathname; return; }
        await sb.auth.signOut();
    });
}

/* ── Data loading ──────────────────────────────────── */

async function loadProfiles() {
    const { data, error } = await sb.from('profiles')
        .select('*')
        .is('deleted_at', null)
        .order('created_at', { ascending: true });
    if (error) { toast(`Couldn’t load profiles: ${error.message}`); return []; }
    return data || [];
}

async function loadProfileData(profileId) {
    const base = (table) => sb.from(table).select('*')
        .eq('profile_id', profileId)
        .is('deleted_at', null);

    const [tp, tasks, subtasks, rewards, redemptions, bonus] = await Promise.all([
        base('time_periods').order('sort_order'),
        base('tasks').order('sort_order'),
        base('subtasks').order('sort_order'),
        base('rewards').order('sort_order'),
        base('reward_redemptions').order('redeemed_at', { ascending: false }),
        base('bonus_points').order('date', { ascending: false }),
    ]);

    const firstError = [tp, tasks, subtasks, rewards, redemptions, bonus].find((r) => r.error)?.error;
    if (firstError) toast(`Couldn’t load data: ${firstError.message}`);

    /* Achievements and timer sessions are read-only extras the Setup
       view shows; loaded here so they follow the same profile switch
       as everything else. */
    await loadReadOnlyExtras(profileId);
    /* Who-has-access is per profile, so it reloads on every switch.
       Not awaited into the render path: an admin-only RPC that a
       non-admin cannot call should not delay the page for them. */
    refreshShares();

    state.data = {
        ...state.data,
        timePeriods: tp.data || [],
        tasks: tasks.data || [],
        subtasks: subtasks.data || [],
        rewards: rewards.data || [],
        redemptions: redemptions.data || [],
        bonus: bonus.data || [],
    };
}

/* What one completion was worth.
 *
 * Points used to be applied retroactively: earnings were
 * points x completion_history.length, so editing a task's value
 * rewrote everything the child had already banked. Each completion now
 * carries a snapshot in `completion_points`, keyed by the UTC day of
 * the completion instant — the same key `dayKey` already produces, and
 * the same one Swift's Task.pointsKey(for:) and the SQL
 * `to_char(c at time zone 'UTC', 'YYYY-MM-DD')` produce. All three
 * agree by construction, which they must: the server re-derives this
 * balance to approve spends.
 *
 * A missing key means no snapshot was recorded, and the fallback to the
 * task's current points is exactly the old behaviour. */
function pointsAwarded(task, completedAt) {
    const snapshot = task.completion_points?.[dayKey(completedAt)];
    return typeof snapshot === 'number' ? snapshot : (task.points || 0);
}

/* Canonical balance — the same formula the server uses in redeem_reward. */
function pointsBalance() {
    const earned = state.data.tasks.reduce(
        (sum, t) => sum + (t.completion_history || []).reduce(
            (acc, ts) => acc + pointsAwarded(t, ts), 0), 0);
    const bonus = state.data.bonus.reduce((sum, b) => sum + (b.amount || 0), 0);
    const spent = state.data.redemptions.reduce((sum, r) => sum + (r.points_spent || 0), 0);
    return earned + bonus - spent;
}

function completionsByDay() {
    const counts = new Map();
    for (const t of state.data.tasks) {
        for (const ts of t.completion_history || []) {
            const k = dayKey(ts);
            counts.set(k, (counts.get(k) || 0) + 1);
        }
    }
    return counts;
}

function streakDays(counts) {
    let streak = 0;
    const cursor = new Date();
    // A streak survives today being unfinished; start from yesterday if today is empty.
    if (!counts.get(dayKey(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
    while (counts.get(dayKey(cursor))) {
        streak += 1;
        cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return streak;
}

/* ── Rendering ─────────────────────────────────────── */

function activeProfile() {
    return state.profiles.find((p) => p.id === state.activeProfileId);
}

function renderGreeting() {
    const hour = new Date().getHours();
    const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const name = activeProfile()?.name;
    $('#greeting-line').textContent = name ? `${part}, ${name}` : part;

    const host = $('#greeting-date');
    // Naming the day explicitly matters once you can leave today: a bare
    // date gives no clue you are no longer looking at the live view.
    const label = isViewingToday() ? `Today · ${fmtDate(viewDate())}` : fmtDate(viewDate());
    host.innerHTML = `
        <span class="dayline">
            <button class="dayline__nav" type="button" id="day-prev" aria-label="Previous day">‹</button>
            <span class="dayline__label">${esc(label)}</span>
            <button class="dayline__nav" type="button" id="day-next" aria-label="Next day"${isViewingToday() ? ' disabled' : ''}>›</button>
            ${isViewingToday() ? '' : '<button class="dayline__today" type="button" id="day-today">Back to today</button>'}
        </span>`;
    $('#day-prev').addEventListener('click', () => shiftDay(-1));
    $('#day-next').addEventListener('click', () => shiftDay(1));
    $('#day-today')?.addEventListener('click', () => { viewKey = todayKey(); renderAll(); });
}

/* Never past today. Completing a future task would bank points for work
   nobody has done yet — the iOS app blocks the same move. */
function shiftDay(delta) {
    const d = viewDate();
    d.setUTCDate(d.getUTCDate() + delta);
    const next = dayKey(d);
    if (next > todayKey()) return;
    viewKey = next;
    renderAll();
}

function renderProfiles() {
    const host = $('#profile-switcher');
    host.innerHTML = state.profiles.map((p) => `
        <button class="profile-chip" type="button" data-profile="${p.id}"
                aria-pressed="${p.id === state.activeProfileId}">
            <span class="profile-chip__avatar">
                ${p.avatar_path
                    ? `<img data-storage-path="${esc(p.avatar_path)}" alt="" hidden><span>${esc((p.name || '?')[0].toUpperCase())}</span>`
                    : `<span>${esc((p.name || '?')[0].toUpperCase())}</span>`}
            </span>
            ${esc(p.name || 'Profile')}
        </button>`).join('');
    host.querySelectorAll('[data-profile]').forEach((btn) => {
        btn.addEventListener('click', () => selectProfile(btn.dataset.profile));
    });
    hydrateImages(host);
}

function renderStats() {
    const counts = completionsByDay();
    const balance = pointsBalance();
    const streak = streakDays(counts);

    const scheduled = state.data.tasks.filter((t) => isScheduledOn(t, viewDate()));
    const doneToday = scheduled.filter((t) => isCompletedOn(t, viewKey)).length;

    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = viewDate();
        d.setUTCDate(d.getUTCDate() - i);
        days.push({ label: WEEKDAY_SHORT[new Date(dayKey(d) + 'T12:00:00Z').getUTCDay()], n: counts.get(dayKey(d)) || 0 });
    }
    const max = Math.max(1, ...days.map((d) => d.n));
    const weekTotal = days.reduce((s, d) => s + d.n, 0);

    $('#stats').innerHTML = `
        <div class="stat" id="stat-balance">
            <div class="stat__label">Points</div>
            <div class="stat__value">⭐ ${balance}</div>
            <div class="stat__meta">available to spend</div>
        </div>
        <div class="stat">
            <div class="stat__label">Streak</div>
            <div class="stat__value">🔥 ${streak}</div>
            <div class="stat__meta">${streak === 1 ? 'day' : 'days'} in a row</div>
        </div>
        <div class="stat">
            <div class="stat__label">Today</div>
            <div class="stat__value">${doneToday}<span style="color:var(--ink-2)">/${scheduled.length}</span></div>
            <div class="stat__meta">tasks done</div>
        </div>
        <div class="stat stat--chart">
            <div class="stat__label">Last 7 days</div>
            <div class="chart-week" role="img" aria-label="${weekTotal} completions in the last 7 days">
                ${days.map((d) => `
                    <div class="chart-week__col">
                        <div class="chart-week__bar ${d.n === 0 ? 'is-empty' : ''}"
                             style="height:${Math.max(4, Math.round((d.n / max) * 44))}px"
                             title="${d.n} on ${d.label}"></div>
                        <span class="chart-week__day">${d.label}</span>
                    </div>`).join('')}
            </div>
        </div>`;
}

function taskRowHtml(task) {
    const done = isCompletedOn(task, viewKey);
    const period = state.data.timePeriods.find((p) => p.id === task.time_period_id);
    const tint = period ? safeColor(period.color) + '22' : null;

    const steps = state.data.subtasks.filter((s) => s.task_id === task.id);
    const stepsDone = steps.filter((s) => s.is_completed).length;

    let rec = null;
    if (Array.isArray(task.recurrence_days) && task.recurrence_days.length) {
        const days = [...task.recurrence_days].sort((a, b) => a - b);
        if (days.length === 7) rec = 'Daily';
        else if (days.join() === '2,3,4,5,6') rec = 'Weekdays';
        else rec = days.map((d) => WEEKDAY_SHORT[(d - 1 + 7) % 7]).join(' · ');
    }

    const due = task.due_date ? new Date(task.due_date) : null;
    const overdue = due && !done && dayKey(due) < todayKey();

    return `
        <div class="task-row ${done ? 'is-done' : ''}" ${done && tint ? `style="--tp-tint:${tint}"` : ''}>
            <button class="task-row__tile" type="button" data-edit="${task.id}"
                    aria-label="Edit ${esc(task.title)}">
                ${task.image_path
                    ? `<img data-storage-path="${esc(task.image_path)}" alt="" hidden><span>${iconFor(task)}</span>`
                    : iconFor(task)}
            </button>
            <button class="task-row__body" type="button" data-edit="${task.id}">
                <div class="task-row__title">${esc(task.title)}</div>
                <div class="task-row__meta">
                    ${task.points ? `<span class="points-pill">★ ${task.points}</span>` : ''}
                    ${rec ? `<span title="Repeats">↻ ${rec}</span>` : ''}
                    ${due ? `<span class="${overdue ? 'is-overdue' : ''}">${overdue ? 'Overdue · ' : ''}${fmtDate(due, { day: 'numeric', month: 'short' })}</span>` : ''}
                    ${steps.length ? `<span>${stepsDone}/${steps.length} steps</span>` : ''}
                </div>
            </button>
            <button class="ring-btn ${done ? 'is-done' : ''}" type="button" data-toggle="${task.id}"
                    aria-pressed="${done}" aria-label="${done ? 'Mark not done' : 'Mark done'}: ${esc(task.title)}">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M4 10.5l4 4 8-9" stroke="currentColor" stroke-width="2.5"
                          stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            </button>
        </div>`;
}

function renderTasks() {
    const host = $('#task-groups');
    const visible = state.data.tasks.filter((t) => state.filter === 'all' || isScheduledOn(t, viewDate()));

    if (!visible.length) {
        host.innerHTML = `
            <div class="empty">
                <img src="../assets/mascot/loa-sleeping.svg" alt="">
                <strong>${state.data.tasks.length ? 'Nothing scheduled today' : 'No tasks yet'}</strong>
                <p>${state.data.tasks.length
                    ? 'Switch to “All” to see every task on this profile.'
                    : 'Add one above, or create tasks in the Vigdís app.'}</p>
            </div>`;
        return;
    }

    const groups = [];
    for (const period of state.data.timePeriods) {
        const tasks = visible.filter((t) => t.time_period_id === period.id);
        if (tasks.length) groups.push({ period, tasks });
    }
    const loose = visible.filter((t) => !t.time_period_id
        || !state.data.timePeriods.some((p) => p.id === t.time_period_id));
    if (loose.length) groups.push({ period: null, tasks: loose });

    host.innerHTML = groups.map(({ period, tasks }) => `
        <div class="tp-group">
            <div class="tp-group__head">
                <span class="tp-group__dot" style="background:${period ? safeColor(period.color) : 'var(--rule)'}"></span>
                ${esc(period ? period.name : 'Anytime')}
                ${period && (period.start_hour || period.end_hour)
                    ? `<span class="tp-group__time">${period.start_hour}:00–${period.end_hour}:00</span>` : ''}
            </div>
            <div class="task-list">${tasks.map(taskRowHtml).join('')}</div>
        </div>`).join('');

    host.querySelectorAll('[data-toggle]').forEach((btn) => {
        btn.addEventListener('click', () => toggleTask(btn.dataset.toggle));
    });
    host.querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', () => openTaskModal(btn.dataset.edit));
    });
    hydrateImages(host);
}

function renderRewards() {
    const host = $('#rewards-list');
    const balance = pointsBalance();
    if (!state.data.rewards.length) {
        host.innerHTML = `
            <div class="empty">
                <strong>No rewards yet</strong>
                <p>Rewards created in the app appear here.</p>
            </div>`;
        return;
    }
    host.innerHTML = state.data.rewards.map((r) => `
        <div class="reward-row">
            <span class="reward-row__tile">
                ${r.image_path
                    ? `<img data-storage-path="${esc(r.image_path)}" alt="" hidden><span>${iconFor(r) || '🎁'}</span>`
                    : (iconFor(r) || '🎁')}
            </span>
            <div class="reward-row__body">
                <div class="reward-row__title">${esc(r.title)}</div>
                <span class="points-pill">★ ${r.cost}</span>
            </div>
            <button class="btn-redeem" type="button" data-redeem="${r.id}"
                    ${balance < (r.cost || 0) ? `disabled title="Needs ${(r.cost || 0) - balance} more points"` : ''}>
                Redeem
            </button>
        </div>`).join('');
    host.querySelectorAll('[data-redeem]').forEach((btn) => {
        btn.addEventListener('click', () => redeemReward(btn.dataset.redeem, btn));
    });
    hydrateImages(host);
}

function renderActivity() {
    const host = $('#activity-list');
    const items = [
        ...state.data.redemptions.map((r) => ({
            when: r.redeemed_at, what: r.reward_title || 'Reward', pts: -(r.points_spent || 0),
        })),
        ...state.data.bonus.map((b) => ({
            when: b.date, what: b.reason || 'Bonus points', pts: b.amount || 0,
        })),
    ].sort((a, b) => new Date(b.when) - new Date(a.when)).slice(0, 8);

    if (!items.length) {
        host.innerHTML = `
            <div class="empty">
                <strong>Quiet so far</strong>
                <p>Redeemed rewards and bonus points show up here.</p>
            </div>`;
        return;
    }
    host.innerHTML = items.map((i) => `
        <div class="activity-row">
            <span class="activity-row__what">${esc(i.what)}</span>
            <span class="activity-row__pts ${i.pts < 0 ? 'is-minus' : 'is-plus'}">${i.pts < 0 ? '−' : '+'}${Math.abs(i.pts)} ★</span>
            <span class="activity-row__date">${fmtDate(i.when, { day: 'numeric', month: 'short' })}</span>
        </div>`).join('');
}

function renderAll() {
    fillPeriodSelect($('#quick-add-period'), $('#quick-add-period')?.value || '');
    renderManagement();
    if (!$('[data-pane="calendar"]')?.hidden) renderCalendar();
    if (!$('[data-pane="stats"]')?.hidden) renderReport();
    renderGreeting();
    renderProfiles();
    renderStats();
    renderTasks();
    renderRewards();
    renderActivity();
}

/* ── Actions ───────────────────────────────────────── */

async function toggleTask(taskId) {
    const task = state.data.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const wasDone = isCompletedOn(task, viewKey);
    const previous = task.completion_history || [];

    // Optimistic: flip locally first, roll back if the server disagrees.
    const now = stampForView();
    task.completion_history = wasDone
        ? previous.filter((ts) => dayKey(ts) !== viewKey)
        : [...previous, now];
    renderStats();
    renderTasks();
    renderRewards();

    /* Only on the positive edge. Un-ticking is a correction, and
       celebrating it would be the app congratulating someone for
       undoing their own work. */
    if (!wasDone) {
        /* Read the row AFTER the re-render above, or we would anchor
           the animation to a node that has just been replaced. */
        const rowEl = document.querySelector(`[data-edit="${taskId}"]`);
        const activeProfile = state.profiles.find((p) => p.id === state.activeProfileId);
        celebrateCompletion({
            rowEl,
            pillEl: $('#stat-balance'),
            points: task.points,
            showConfetti: activeProfile?.show_confetti ?? true,
        });
    }
    if (DEMO) return;

    const { data, error } = await sb.rpc('set_task_completion', {
        target_profile_id: state.activeProfileId,
        target_task_id: taskId,
        completed_at: now,
        is_completed: !wasDone,
    });

    if (error) {
        task.completion_history = previous;
        renderStats();
        renderTasks();
        renderRewards();
        toast(`Couldn’t save that: ${error.message}`, {
            actionLabel: 'Try again',
            onAction: () => toggleTask(taskId),
        });
        return;
    }
    if (data?.completion_history) task.completion_history = data.completion_history;
    // The RPC snapshots the value server-side; take it back so the
    // balance shown here matches the one the server will check against.
    if (data?.completion_points) task.completion_points = data.completion_points;
}

async function quickAddTask(title) {
    const sortMax = Math.max(0, ...state.data.tasks.map((t) => t.sort_order || 0));
    const row = {
        id: crypto.randomUUID(),
        profile_id: state.activeProfileId,
        title,
        points: 0,
        task_type: 'regular',
        behavior_type: 'regular',
        icon: '📝',
        tags: [],
        sort_order: sortMax + 1,
        time_period_id: $('#quick-add-period')?.value || null,
    };
    if (DEMO) {
        state.data.tasks.push({ ...row, completion_history: [], completion_points: {} });
        renderStats();
        renderTasks();
        return true;
    }
    const { data, error } = await sb.from('tasks').insert(row).select().single();
    if (error) {
        toast(`Couldn’t add the task: ${error.message}`);
        return false;
    }
    state.data.tasks.push(data);
    renderStats();
    renderTasks();
    return true;
}

/* Fills any <select> with the profile's time periods. "No period" is a
   real option, not a placeholder — the iOS app tolerates period-less
   tasks and renders them in a loose group, so the web must be able to
   express that too rather than silently forcing a period. */
function fillPeriodSelect(el, selectedId) {
    if (!el) return;
    const opts = ['<option value="">No time period</option>'];
    for (const p of state.data.timePeriods) {
        opts.push(`<option value="${esc(p.id)}"${p.id === selectedId ? ' selected' : ''}>${esc(p.name || 'Period')}</option>`);
    }
    el.innerHTML = opts.join('');
}

/* Photo chosen in the modal but not yet uploaded. Held until Save so
   cancelling cannot leave an orphaned object in storage, and so a photo
   swap costs one upload rather than one per preview. */
let pendingPhoto = null;
let pendingPhotoRemoval = false;

/* Match the iOS client's contract exactly (CloudImageStorageService):
   640px longest edge, JPEG quality 0.68, 320 KB ceiling, written to
   tasks/<uuid>/image.jpg. If the web wrote a different shape the two
   clients would disagree about the same task's picture. */
const IMG_MAX_DIM = 640, IMG_QUALITY = 0.68, IMG_BYTE_LIMIT = 320 * 1024;

async function compressImage(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, IMG_MAX_DIM / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();

    // Step the quality down until it fits, rather than rejecting a photo
    // a parent just took on a modern phone — those are routinely over the
    // limit at first pass.
    let quality = IMG_QUALITY;
    for (let i = 0; i < 5; i++) {
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
        if (!blob) return null;
        if (blob.size <= IMG_BYTE_LIMIT || quality <= 0.3) return blob;
        quality -= 0.12;
    }
    return null;
}

async function uploadTaskPhoto(taskId, file) {
    const blob = await compressImage(file);
    if (!blob) { toast('Couldn’t process that image.'); return null; }
    const path = `tasks/${String(taskId).toLowerCase()}/image.jpg`;
    const { error } = await sb.storage.from(IMAGE_BUCKET).upload(path, blob, {
        contentType: 'image/jpeg',
        cacheControl: '86400',
        upsert: true,
    });
    if (error) { toast(`Couldn’t upload photo: ${error.message}`); return null; }
    urlCache.delete(path); // force a fresh signed URL for the replacement
    return path;
}

function renderPhotoField(task) {
    const preview = $('#task-photo-preview');
    const removeBtn = $('#btn-photo-remove');
    const path = pendingPhotoRemoval ? null : (task?.image_path || null);
    if (pendingPhoto) {
        preview.innerHTML = `<img alt="" src="${URL.createObjectURL(pendingPhoto)}">`;
        removeBtn.hidden = false;
    } else if (path) {
        preview.innerHTML = `<img data-storage-path="${esc(path)}" alt="" hidden>`;
        hydrateImages(preview);
        removeBtn.hidden = false;
    } else {
        preview.innerHTML = '<span class="photo-field__empty">No photo</span>';
        removeBtn.hidden = true;
    }
}

function openTaskModal(taskId) {
    const task = state.data.tasks.find((t) => t.id === taskId);
    if (!task) return;
    state.editingTaskId = taskId;
    $('#task-title').value = task.title || '';
    $('#task-points').value = task.points ?? 0;
    $('#task-icon').value = /^[a-z0-9.]+$/i.test(task.icon || '') ? '' : (task.icon || '');
    $('#task-due').value = task.due_date ? dayKey(task.due_date) : '';
    $('#task-notes').value = task.notes || '';
    fillPeriodSelect($('#task-period'), task.time_period_id || '');
    pendingPhoto = null;
    pendingPhotoRemoval = false;
    $('#task-photo').value = '';
    renderPhotoField(task);
    setRecurrence(Array.isArray(task.recurrence_days) ? task.recurrence_days : []);
    renderTaskSteps(task.id);
    $('#modal-task').showModal();
}

async function saveTaskEdits() {
    const task = state.data.tasks.find((t) => t.id === state.editingTaskId);
    if (!task) return;
    const patch = {
        /* Recurrence comes from the setup module's checkboxes. Folded
           into this patch rather than written separately so the whole
           task saves in one round trip — two writes would leave a
           window where the days changed but the title didn't. */
        ...readRecurrence(),
        title: $('#task-title').value.trim() || task.title,
        points: Math.max(0, parseInt($('#task-points').value, 10) || 0),
        notes: $('#task-notes').value.trim() || null,
        due_date: $('#task-due').value ? new Date($('#task-due').value + 'T12:00:00').toISOString() : null,
        time_period_id: $('#task-period').value || null,
    };
    const icon = $('#task-icon').value.trim();
    if (icon) patch.icon = icon;

    // Photo resolves before the row update so image_path and the stored
    // object commit together — a failed upload must not leave the row
    // pointing at a file that was never written.
    if (!DEMO && pendingPhoto) {
        const path = await uploadTaskPhoto(task.id, pendingPhoto);
        if (!path) return;
        patch.image_path = path;
    } else if (pendingPhotoRemoval) {
        patch.image_path = null;
    }

    if (DEMO) {
        Object.assign(task, patch);
        renderStats(); renderTasks(); renderRewards();
        return;
    }
    const { data, error } = await sb.from('tasks')
        .update(patch).eq('id', task.id).select().single();
    if (error) { toast(`Couldn’t save: ${error.message}`); return; }
    Object.assign(task, data);
    renderStats();
    renderTasks();
    renderRewards();
}

async function deleteTask() {
    const task = state.data.tasks.find((t) => t.id === state.editingTaskId);
    if (!task) return;
    $('#modal-task').close();

    // Optimistic soft delete with Undo — matches the app's sync model (deleted_at).
    state.data.tasks = state.data.tasks.filter((t) => t.id !== task.id);
    renderStats(); renderTasks(); renderRewards();

    if (DEMO) {
        toast(`Deleted “${task.title}”.`, {
            actionLabel: 'Undo',
            duration: 8000,
            onAction: () => {
                state.data.tasks.push(task);
                renderStats(); renderTasks(); renderRewards();
            },
        });
        return;
    }
    const { error } = await sb.from('tasks')
        .update({ deleted_at: new Date().toISOString() }).eq('id', task.id);
    if (error) {
        state.data.tasks.push(task);
        renderStats(); renderTasks(); renderRewards();
        toast(`Couldn’t delete: ${error.message}`);
        return;
    }
    toast(`Deleted “${task.title}”.`, {
        actionLabel: 'Undo',
        duration: 8000,
        onAction: async () => {
            const { error: undoErr } = await sb.from('tasks')
                .update({ deleted_at: null }).eq('id', task.id);
            if (undoErr) { toast(`Couldn’t restore: ${undoErr.message}`); return; }
            state.data.tasks.push(task);
            renderStats(); renderTasks(); renderRewards();
        },
    });
}

async function redeemReward(rewardId, btn) {
    const reward = state.data.rewards.find((r) => r.id === rewardId);
    if (!reward) return;
    btn.disabled = true;
    btn.textContent = '…';

    if (DEMO) {
        state.data.redemptions.unshift({
            id: crypto.randomUUID(), profile_id: state.activeProfileId,
            reward_title: reward.title, points_spent: reward.cost, redeemed_at: new Date().toISOString(),
        });
        renderStats(); renderRewards(); renderActivity();
        toast(`Redeemed “${reward.title}” for ${reward.cost} points ⭐`);
        return;
    }
    const { data, error } = await sb.rpc('redeem_reward', {
        target_profile_id: state.activeProfileId,
        target_reward_id: rewardId,
        redemption_id: crypto.randomUUID(),
        idempotency_key: crypto.randomUUID(),
    });

    if (error) {
        btn.disabled = false;
        btn.textContent = 'Redeem';
        toast(error.message.includes('Not enough')
            ? 'Not enough points for that reward yet.'
            : `Couldn’t redeem: ${error.message}`);
        return;
    }
    state.data.redemptions.unshift(data);
    renderStats();
    renderRewards();
    renderActivity();
    toast(`Redeemed “${reward.title}” for ${reward.cost} points ⭐`);
}

/* ── Realtime — live updates when the app changes data ── */

function subscribeRealtime(profileId) {
    if (state.channel) sb.removeChannel(state.channel);
    const reload = debounce(async () => {
        await loadProfileData(profileId);
        if (state.activeProfileId === profileId) renderAll();
    }, 800);

    state.channel = sb.channel(`web-dashboard-${profileId}`);
    for (const table of ['tasks', 'subtasks', 'time_periods', 'rewards', 'reward_redemptions', 'bonus_points']) {
        state.channel.on('postgres_changes',
            { event: '*', schema: 'public', table, filter: `profile_id=eq.${profileId}` },
            reload);
    }
    state.channel.subscribe();
}

/* ── Flow ──────────────────────────────────────────── */

async function selectProfile(profileId, { skeleton = true } = {}) {
    clearCelebrations();
    state.activeProfileId = profileId;
    /* Wear this profile's theme. Applied before the data loads so the
       skeletons below are already the right colour — switching child and
       watching the page recolour a beat later would look like a glitch. */
    applyProfileTheme(state.profiles.find((p) => p.id === profileId));
    renderProfiles();
    if (DEMO) { state.data = demoData(profileId); renderAll(); return; }
    if (skeleton) {
        $('#task-groups').innerHTML = '<div class="skeleton"></div>'.repeat(3);
        $('#rewards-list').innerHTML = '<div class="skeleton"></div>';
        $('#activity-list').innerHTML = '<div class="skeleton"></div>';
    }
    await loadProfileData(profileId);
    renderAll();
    subscribeRealtime(profileId);
}

async function enterApp() {
    showView('view-app');
    $('#user-email').textContent = state.session?.user?.email || '';

    /* Hand the setup module its dependencies once, on the way in. It
       needs the client and the shared state, and `refresh` so a write
       re-reads and re-renders through the same path the rest of the
       page uses rather than keeping its own copy of the data. */
    initManagement({
        sb,
        state,
        $,
        esc,
        toast,
        /* Do mode completes through the task list's own toggle so the
           write, the server function and the celebration are identical
           either way. */
        toggleTask,
        refresh: async () => {
            if (state.activeProfileId) await loadProfileData(state.activeProfileId);
            renderAll();
        },
    });

    /* Adding or removing a profile changes a list that lives outside
       the per-profile data bundle, so the setup module needs its own
       way to re-read it and land the user somewhere valid. */
    setProfileReloader(async () => {
        state.profiles = await loadProfiles();
        const stillThere = state.profiles.some((p) => p.id === state.activeProfileId);
        if (!stillThere) {
            const next = state.profiles[0];
            if (next) { await selectProfile(next.id); return; }
            state.activeProfileId = null;
        }
        if (state.activeProfileId) await loadProfileData(state.activeProfileId);
        renderAll();
    });

    state.profiles = await loadProfiles();
    /* Entitlement drives whether the Setup view will let this account
       add another profile. Read after profiles so the owned-profile
       count it compares against is populated. Deliberately not awaited
       into the critical path below — a slow entitlement read should not
       delay the first paint of the task list. */
    loadEntitlement();
    /* The referral code belongs to the account, not the profile, so it
       is fetched once on entry rather than per switch. */
    loadReferralCode();

    if (!state.profiles.length) {
        $('#profile-switcher').innerHTML = '';
        $('#stats').innerHTML = '';
        $('#task-groups').innerHTML = `
            <div class="empty">
                <img src="../assets/mascot/loa-sleeping.svg" alt="">
                <strong>No cloud profiles found</strong>
                <p>Open the Vigdís app, turn on Cloud Sync in Settings, and your family's data will appear here.</p>
            </div>`;
        $('#rewards-list').innerHTML = '';
        $('#activity-list').innerHTML = '';
        renderGreeting();
        return;
    }
    const remembered = localStorage.getItem('vigdis-web-profile');
    const initial = state.profiles.find((p) => p.id === remembered) || state.profiles[0];
    await selectProfile(initial.id);
}

/* One row per completion, which is the shape a review actually needs:
   "what did this person do, and when". A weekly total would be easier to
   produce and useless for the thing this is for — evidencing progress in
   a review, a report or an individual plan, where the specific days are
   the point.

   Built client-side from data already loaded, so it costs no request and
   works on whatever the dashboard is showing. */
function buildCSV() {
    const profile = activeProfile();
    const periods = new Map(state.data.timePeriods.map((p) => [p.id, p.name]));
    const rows = [['Profile', 'Date', 'Task', 'Time period', 'Points']];

    const completions = [];
    for (const t of state.data.tasks) {
        for (const ts of t.completion_history || []) {
            completions.push({
                date: dayKey(ts),
                title: t.title || '',
                period: periods.get(t.time_period_id) || '',
                points: t.points || 0,
            });
        }
    }
    completions.sort((a, b) => (a.date === b.date ? a.title.localeCompare(b.title) : a.date.localeCompare(b.date)));
    for (const c of completions) {
        rows.push([profile?.name || '', c.date, c.title, c.period, String(c.points)]);
    }

    /* Excel and Numbers both treat a leading = + - @ as a formula, so a
       task literally named "=SUM(A1)" would execute on open. Prefixing
       with an apostrophe is the standard defence. Quotes are doubled and
       every field is quoted so commas in task names survive. */
    const cell = (v) => {
        let out = String(v ?? '');
        if (/^[=+\-@]/.test(out)) out = "'" + out;
        return '"' + out.replace(/"/g, '""') + '"';
    };
    return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

function exportCSV() {
    const profile = activeProfile();
    // BOM so Excel opens UTF-8 correctly — without it Icelandic names
    // arrive mangled, which is exactly the audience that would notice.
    const blob = new Blob(['\uFEFF' + buildCSV()], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vigdis-${(profile?.name || 'profile').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${todayKey()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/* Copy the open task to other profiles.
   This is the one bulk primitive that actually earns its place here. A
   practitioner running the same "wash hands" step across eight children
   otherwise types it eight times, and a full multi-select editing mode
   would be a lot of surface for a job that is nearly always "give this
   to those people too". Copies are independent rows from the moment they
   land — editing one later does not touch the others, which is what you
   want when one child's version drifts.

   Photos are shared by reference rather than duplicated: storage paths
   are per task id, so a copy points at its own path only once it gets
   its own photo. The copy starts without one. */
function openCopyModal() {
    const task = state.data.tasks.find((t) => t.id === state.editingTaskId);
    if (!task) return;
    const others = state.profiles.filter((p) => p.id !== state.activeProfileId);
    $('#copy-sub').textContent = others.length
        ? `Give “${task.title}” to other profiles as well.`
        : 'There is only one profile on this account.';
    $('#copy-list').innerHTML = others.map((p) => `
        <label class="copy-row">
            <input type="checkbox" value="${esc(p.id)}">
            <span>${esc(p.name || 'Profile')}</span>
        </label>`).join('') || '';
    $('#btn-copy-save').disabled = others.length === 0;
    $('#modal-task').close();
    $('#modal-copy').showModal();
}

async function copyTaskToProfiles() {
    const task = state.data.tasks.find((t) => t.id === state.editingTaskId);
    if (!task) return;
    const ids = Array.from($('#copy-list').querySelectorAll('input:checked')).map((i) => i.value);
    if (!ids.length) return;

    const rows = ids.map((profileId) => ({
        id: crypto.randomUUID(),
        profile_id: profileId,
        title: task.title,
        points: task.points || 0,
        notes: task.notes || null,
        icon: task.icon || '📝',
        task_type: task.task_type || 'regular',
        behavior_type: task.behavior_type || 'regular',
        recurrence_days: task.recurrence_days || null,
        tags: [],
        sort_order: 9999,
        // Deliberately not copied: time_period_id, because periods belong
        // to a profile and another profile's ids would be meaningless or
        // rejected; completion_history, which is that child's record;
        // image_path, which is keyed to this task's id.
    }));

    if (DEMO) {
        toast(`Copied to ${ids.length} profile${ids.length === 1 ? '' : 's'}.`);
        return;
    }
    const { error } = await sb.from('tasks').insert(rows);
    if (error) { toast(`Couldn’t copy: ${error.message}`); return; }
    toast(`Copied “${task.title}” to ${ids.length} profile${ids.length === 1 ? '' : 's'}.`);
}

/* ── Calendar ──────────────────────────────────────────
   A month of completion density. Its job is orientation — "which days
   did we actually do this" — so it encodes volume as depth of colour
   rather than printing counts in 31 small boxes, which is unreadable at
   a glance and is what the Statistics view is for.

   Clicking a day sends you to it in Today, which is why the day
   navigation went in first: the calendar is a jump target for it. */
let calMonth = new Date(todayKey() + 'T12:00:00Z');

function renderCalendar() {
    const host = $('#calendar-grid');
    if (!host) return;
    const counts = completionsByDay();

    const year = calMonth.getUTCFullYear(), month = calMonth.getUTCMonth();
    const first = new Date(Date.UTC(year, month, 1));
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    // Monday-first: Icelandic and most European calendars start there,
    // and getUTCDay() is Sunday-first, hence the shift.
    const lead = (first.getUTCDay() + 6) % 7;

    $('#cal-month').textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    // Never navigate past the current month — there is nothing there.
    $('#cal-next').disabled = year > new Date().getUTCFullYear()
        || (year === new Date().getUTCFullYear() && month >= new Date().getUTCMonth());

    const max = Math.max(1, ...counts.values());
    const cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
        .map((d) => `<div class="cal__dow">${d}</div>`);
    for (let i = 0; i < lead; i++) cells.push('<div class="cal__pad"></div>');

    for (let day = 1; day <= daysInMonth; day++) {
        const key = dayKey(new Date(Date.UTC(year, month, day)));
        const n = counts.get(key) || 0;
        const future = key > todayKey();
        // Four steps, not a continuous ramp: a smooth gradient reads as
        // noise at this size, while four levels are countable by eye.
        const level = n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
        const cls = ['cal__day', `is-l${level}`];
        if (key === todayKey()) cls.push('is-today');
        if (key === viewKey) cls.push('is-viewing');
        if (future) cls.push('is-future');
        cells.push(`<button class="${cls.join(' ')}" type="button" data-day="${key}"${future ? ' disabled' : ''}
            aria-label="${key}: ${n} completed">${day}</button>`);
    }
    // Month summary, computed from the same counts the grid is drawing.
    let monthTotal = 0, monthActive = 0, bestDay = null, bestN = 0;
    for (let day = 1; day <= daysInMonth; day++) {
        const key = dayKey(new Date(Date.UTC(year, month, day)));
        const n = counts.get(key) || 0;
        if (!n) continue;
        monthTotal += n; monthActive++;
        if (n > bestN) { bestN = n; bestDay = day; }
    }
    const elapsed = Math.min(daysInMonth, (year === new Date().getUTCFullYear() && month === new Date().getUTCMonth())
        ? new Date().getUTCDate() : daysInMonth);

    host.innerHTML = `
        <div class="cal-wrap">
            <div>
                <div class="cal">${cells.join('')}</div>
                <div class="cal__legend"><span>Less</span>
                    <i style="background:rgba(0,0,0,.035)"></i>
                    <i style="background:rgba(240,145,144,.22)"></i>
                    <i style="background:rgba(240,145,144,.42)"></i>
                    <i style="background:rgba(240,145,144,.66)"></i>
                    <i style="background:rgba(240,145,144,.92)"></i>
                    <span>More</span>
                </div>
                <p class="cal__hint">Pick a day to open it in Today.</p>
            </div>
            <aside class="cal-side">
                <h3 class="rhead">This month</h3>
                <div class="cal-side__stat"><b>${monthTotal}</b><span>steps completed</span></div>
                <div class="cal-side__stat"><b>${monthActive} of ${elapsed}</b><span>days with something done</span></div>
                <div class="cal-side__stat"><b>${bestDay ? bestDay + ' ' + first.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }) : '—'}</b><span>busiest day${bestN ? ` · ${bestN} steps` : ''}</span></div>
            </aside>
        </div>`;
    host.querySelectorAll('[data-day]').forEach((b) => {
        b.addEventListener('click', () => {
            viewKey = b.dataset.day;
            setView('today');
            renderAll();
        });
    });
}

/* ── Statistics ────────────────────────────────────────
   Answers the questions a review actually asks: is this working overall,
   which steps are reliable, which are consistently the hard ones, and
   when in the day does it fall apart. Per-task reliability is the one
   most worth having — it turns "they're struggling" into "getting
   dressed works four days in five, teeth are the problem". */
function renderReport() {
    const host = $('#report-body');
    if (!host) return;
    const days = parseInt($('#report-range')?.value || '30', 10);

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - (days - 1));
    let sinceKey = dayKey(since);

    /* Clamp the window to when this profile actually started.
       Without this a profile with a week of history scored 23% over a
       30-day range — the denominator counted three weeks in which the
       task did not yet exist, so every number read as failure. A review
       surface that makes a good week look like a bad month is worse than
       no numbers at all. */
    const allDates = state.data.tasks.flatMap((t) => (t.completion_history || []).map(dayKey));
    const firstEver = allDates.length ? allDates.reduce((a, b) => (a < b ? a : b)) : null;
    if (firstEver && firstEver > sinceKey) sinceKey = firstEver;
    const spanDays = Math.max(1, Math.round((Date.parse(todayKey()) - Date.parse(sinceKey)) / 86400000) + 1);

    const inRange = (ts) => dayKey(ts) >= sinceKey && dayKey(ts) <= todayKey();
    const periods = new Map(state.data.timePeriods.map((p) => [p.id, p.name]));
    const perTask = [];
    let total = 0;
    const byPeriod = new Map();
    const activeDays = new Set();

    for (const t of state.data.tasks) {
        const hits = (t.completion_history || []).filter(inRange);
        total += hits.length;
        hits.forEach((ts) => activeDays.add(dayKey(ts)));
        const label = periods.get(t.time_period_id) || 'No period';
        byPeriod.set(label, (byPeriod.get(label) || 0) + hits.length);
        // Scheduled days only: a weekdays-only task must not be marked
        // down for the weekends it was never due.
        let due = 0;
        for (let i = 0; i < spanDays; i++) {
            const d = new Date(Date.parse(sinceKey) + i * 86400000);
            if (isScheduledOn(t, d)) due++;
        }
        perTask.push({ title: t.title || 'Untitled', done: hits.length, due, rate: due ? hits.length / due : 0 });
    }

    const ranked = perTask.filter((t) => t.due > 0).sort((a, b) => b.rate - a.rate || b.done - a.done);
    const bar = (rate) => `<span class="rbar"><span style="width:${Math.round(rate * 100)}%"></span></span>`;
    const row = (t) => `<li><span class="rrow__t">${esc(t.title)}</span>${bar(t.rate)}
        <span class="rrow__n">${Math.round(t.rate * 100)}%<small> ${t.done}/${t.due}</small></span></li>`;

    /* With a short list, a "best five" and a "worst five" are the same
       five tasks printed twice, which reads as a rendering fault. Below
       ten, show one ranked list; above it, split into two that cannot
       overlap. */
    let taskSections;
    if (ranked.length === 0) {
        taskSections = `<h3 class="rhead">Every task</h3><ul class="rlist"><li class="rempty">Nothing recorded yet.</li></ul>`;
    } else if (ranked.length < 10) {
        taskSections = `<h3 class="rhead">Every task · most to least reliable</h3>
            <ul class="rlist">${ranked.map(row).join('')}</ul>`;
    } else {
        taskSections = `<h3 class="rhead">Most reliable</h3>
            <ul class="rlist">${ranked.slice(0, 5).map(row).join('')}</ul>
            <h3 class="rhead">Needs the most support</h3>
            <ul class="rlist">${ranked.slice(-5).reverse().map(row).join('')}</ul>`;
    }

    const periodRows = [...byPeriod.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const periodMax = Math.max(1, ...periodRows.map((r) => r[1]));

    // Say the window out loud when it was clamped, so 7 of 7 is not read
    // as 7 of 30.
    const windowNote = firstEver && spanDays < days
        ? `<p class="rnote">Showing ${spanDays} days — that is all the history this profile has.</p>` : '';

    host.innerHTML = `
        <div class="rgrid">
            <div class="rstat"><b>${total}</b><span>steps completed</span></div>
            <div class="rstat"><b>${activeDays.size} of ${spanDays}</b><span>days active</span></div>
            <div class="rstat"><b>${total && activeDays.size ? (total / activeDays.size).toFixed(1) : '0'}</b><span>per active day</span></div>
        </div>
        ${windowNote}
        ${taskSections}
        <h3 class="rhead">By time of day</h3>
        <ul class="rlist">${periodRows.map(([name, n]) => `<li><span class="rrow__t">${esc(name)}</span>
            ${bar(n / periodMax)}<span class="rrow__n">${n}</span></li>`).join('') || '<li class="rempty">Nothing recorded yet.</li>'}</ul>`;
}

function setView(name, pushHash = true) {
    document.querySelectorAll('.viewtab').forEach((t) =>
        t.setAttribute('aria-selected', String(t.dataset.view === name)));
    document.querySelectorAll('.viewpane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
    if (name === 'calendar') renderCalendar();
    if (name === 'stats') renderReport();
    if (name === 'manage') renderManagement();
    // Hash must not collide with an element id or the browser scroll-jumps
    // to it on load — "#stats" matched the stats strip and scrolled the
    // greeting off screen.
    const hash = name === 'today' ? '' : (name === 'stats' ? '#statistics' : `#${name}`);
    if (pushHash) history.replaceState(null, '', hash || location.pathname + location.search);
}

function bindAppUI() {
    document.querySelectorAll('.viewtab').forEach((t) =>
        t.addEventListener('click', () => setView(t.dataset.view)));
    const initial = location.hash.replace('#', '');
    if (initial === 'calendar') setView('calendar', false);
    if (initial === 'statistics') setView('stats', false);
    if (initial === 'manage') setView('manage', false);
    $('#cal-prev')?.addEventListener('click', () => {
        calMonth.setUTCMonth(calMonth.getUTCMonth() - 1); renderCalendar();
    });
    $('#cal-next')?.addEventListener('click', () => {
        calMonth.setUTCMonth(calMonth.getUTCMonth() + 1); renderCalendar();
    });
    $('#report-range')?.addEventListener('change', renderReport);

    $('#btn-task-copy')?.addEventListener('click', openCopyModal);
    $('#btn-copy-cancel')?.addEventListener('click', () => $('#modal-copy').close());
    $('#form-copy')?.addEventListener('submit', copyTaskToProfiles);

    $('#task-photo')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        pendingPhoto = file;
        pendingPhotoRemoval = false;
        renderPhotoField(state.data.tasks.find((t) => t.id === state.editingTaskId));
    });
    $('#btn-photo-remove')?.addEventListener('click', () => {
        pendingPhoto = null;
        pendingPhotoRemoval = true;
        $('#task-photo').value = '';
        renderPhotoField(state.data.tasks.find((t) => t.id === state.editingTaskId));
    });

    $('#btn-export')?.addEventListener('click', exportCSV);

    document.querySelectorAll('.filter-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            state.filter = chip.dataset.filter;
            document.querySelectorAll('.filter-chip').forEach((c) =>
                c.setAttribute('aria-pressed', String(c === chip)));
            renderTasks();
        });
    });

    $('#form-quick-add').addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = $('#in-quick-add');
        const title = input.value.trim();
        if (!title || !state.activeProfileId) return;
        const btn = $('#btn-quick-add');
        btn.disabled = true;
        const ok = await quickAddTask(title);
        btn.disabled = false;
        if (ok) input.value = '';
    });

    const modal = $('#modal-task');
    $('#form-task').addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveTaskEdits();
        modal.close();
    });
    $('#btn-task-cancel').addEventListener('click', () => modal.close());
    $('#btn-task-delete').addEventListener('click', deleteTask);
}

/* Remember the chosen profile across visits. */
const persistProfile = () => {
    if (state.activeProfileId) localStorage.setItem('vigdis-web-profile', state.activeProfileId);
};
window.addEventListener('pagehide', persistProfile);

/* ── Demo mode (sample data, no server writes) ─────── */

function demoData(profileId) {
    const daysAgo = (n, hour = 16) => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - n);
        d.setUTCHours(hour, 12, 0, 0);
        return d.toISOString();
    };
    const tp = (id, name, color, start, end, sort) => ({
        id, profile_id: profileId, name, color, start_hour: start, end_hour: end, sort_order: sort,
    });
    const periods = [
        tp('tp-1', 'Morning', '#F2A659', 7, 9, 0),
        tp('tp-2', 'After school', '#73BFF2', 14, 17, 1),
        tp('tp-3', 'Evening', '#8B5CF6', 19, 21, 2),
    ];
    const everyDay = [1, 2, 3, 4, 5, 6, 7];
    const tasks = [
        { id: 't-1', profile_id: profileId, title: 'Brush teeth', icon: '🪥', points: 10, time_period_id: 'tp-1', recurrence_days: everyDay, sort_order: 0, completion_history: [0, 1, 2, 3, 4, 5, 6].map((n) => daysAgo(n, 8)) },
        { id: 't-2', profile_id: profileId, title: 'Make the bed', icon: '🛏️', points: 5, time_period_id: 'tp-1', recurrence_days: everyDay, sort_order: 1, completion_history: [1, 2, 4].map((n) => daysAgo(n, 8)) },
        { id: 't-3', profile_id: profileId, title: 'Homework', icon: '📚', points: 20, time_period_id: 'tp-2', recurrence_days: [2, 3, 4, 5, 6], sort_order: 2, completion_history: [1, 3].map((n) => daysAgo(n)) },
        { id: 't-4', profile_id: profileId, title: 'Read a book', icon: '📖', points: 15, time_period_id: 'tp-3', recurrence_days: everyDay, sort_order: 3, completion_history: [1, 2, 3, 5].map((n) => daysAgo(n, 20)) },
        { id: 't-5', profile_id: profileId, title: 'Feed the cat', icon: '🐱', points: 10, time_period_id: null, recurrence_days: everyDay, sort_order: 4, completion_history: [0, 1, 2].map((n) => daysAgo(n, 17)) },
        { id: 't-6', profile_id: profileId, title: 'Pack for football practice', icon: '⚽', points: 10, time_period_id: null, recurrence_days: null, due_date: daysAgo(-2), sort_order: 5, completion_history: [] },
    ];
    const subtasks = [
        { id: 's-1', task_id: 't-3', profile_id: profileId, title: 'Maths', is_completed: true, sort_order: 0 },
        { id: 's-2', task_id: 't-3', profile_id: profileId, title: 'Reading', is_completed: true, sort_order: 1 },
        { id: 's-3', task_id: 't-3', profile_id: profileId, title: 'Icelandic', is_completed: false, sort_order: 2 },
    ];
    const rewards = [
        { id: 'r-1', profile_id: profileId, title: 'Movie night', icon: '🍿', cost: 100, sort_order: 0 },
        { id: 'r-2', profile_id: profileId, title: 'Ice-cream trip', icon: '🍦', cost: 60, sort_order: 1 },
        { id: 'r-3', profile_id: profileId, title: '30 min extra screen time', icon: '🎮', cost: 40, sort_order: 2 },
    ];
    const redemptions = [
        { id: 'rd-1', profile_id: profileId, reward_title: 'Ice-cream trip', points_spent: 60, redeemed_at: daysAgo(3) },
    ];
    const bonus = [
        { id: 'b-1', profile_id: profileId, amount: 20, reason: 'Helped with the groceries', date: daysAgo(1) },
    ];
    return { timePeriods: periods, tasks, subtasks, rewards, redemptions, bonus };
}

async function enterDemo() {
    showView('view-app');
    $('#user-email').textContent = 'Sample data';
    state.profiles = [
        { id: 'demo-1', name: 'Anna', avatar_path: null },
        { id: 'demo-2', name: 'Kári', avatar_path: null },
    ];
    await selectProfile('demo-1');
}

/* ── Boot ──────────────────────────────────────────── */

bindAuthUI();
bindAppUI();
surfaceOAuthError();

let booted = false;
if (DEMO) enterDemo();
else sb.auth.onAuthStateChange((event, session) => {
    state.session = session;

    if (event === 'PASSWORD_RECOVERY') {
        showView('view-recovery');
        return;
    }
    if (session) {
        if (!booted) {
            booted = true;
            // Defer Supabase calls out of the auth callback (SDK guidance).
            setTimeout(() => enterApp(), 0);
        }
    } else {
        booted = false;
        if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
        showView('view-auth');
    }
});
