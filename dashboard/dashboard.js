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
    loadReferralCode, applyProfileTheme, openProfileModal, openShareModal,
    openRewardModal,
} from './manage.js';
/* The completion moment — points fly, Lóa cheers, confetti. */
import { celebrateCompletion, clearCelebrations } from './celebrate.js';
import { trendChart, barChart, rankBars, reliabilityRows } from './charts.js';
/* The Settings tab — the app's grouped list and its sub-pages. */
import {
    initSettings, bindSettings, renderSettings, settingsHeader, settingsBack, resetSettings,
} from './settings.js';

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
    data: { timePeriods: [], tasks: [], subtasks: [], rewards: [], redemptions: [], bonus: [] },
    channel: null,
    editingTaskId: null,
    /* Which time-of-day tile is selected on Tasks. Null means "pick the
       one that fits the clock", resolved in renderTasks. */
    periodSel: null,
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

/* Whether a task belongs on `date`. Ported from the app's
   `TaskListView.matchesSelectedDate` so both clients answer the same
   question the same way — this used to diverge in three places:

   1. A task appeared on every past day, including days before it
      existed. Step back a week in the app and a task made yesterday is
      simply not there; on the web it was, with a 0% completion rate
      attached to days it could not possibly have been done. That is
      what `created_at` fixes below, and it is also why the statistics
      view kept reporting misses that never happened.

   2. `recurrence_days` was always read as weekdays. For a monthly task
      those numbers are days of the MONTH, so a task set to the 1st was
      showing every Sunday — the same bug the app fixed by storing an
      explicit `recurrence_pattern` instead of inferring one.

   3. A due date was ignored, so a one-off with a due date showed on
      every day rather than on its day. */
function isScheduledOn(task, date) {
    /* End of the viewed day, as an exclusive upper bound. A task
       created at 21:00 still counts as belonging to that whole day. */
    const endOfDay = new Date(date);
    endOfDay.setUTCHours(23, 59, 59, 999);
    const existedYet = !task.created_at || new Date(task.created_at) < endOfDay;

    if (task.due_date) {
        return dayKey(task.due_date) === dayKey(date);
    }

    const rec = task.recurrence_days;
    if (Array.isArray(rec) && rec.length > 0) {
        /* Rows written before the discriminator existed carry no
           pattern; the app falls back to inferring weekly for those, so
           this does too rather than newly changing their behaviour. */
        switch (task.recurrence_pattern || 'weekly') {
            case 'daily':
                return existedYet;
            case 'monthly':
                return rec.includes(date.getUTCDate()) && existedYet;
            case 'weekly':
            default:
                return rec.includes(appWeekday(date)) && existedYet;
        }
    }

    // Plain one-off: no due date, no recurrence. Stays visible until done.
    return true;
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

async function signOut() {
    if (DEMO) { location.href = location.pathname; return; }
    await sb.auth.signOut();
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

    $('#btn-signout').addEventListener('click', signOut);
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
    /* Sharing is no longer eagerly loaded. It moved from a panel that
       always described the active profile into a modal opened from a
       specific profile row, so the RPC now runs when someone actually
       asks who has access — one fewer admin-only call on every profile
       switch, and no ambiguity about which profile it described. */

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

/* ── Page header ───────────────────────────────────────
   Mirrors the top of each app screen. Tasks: a date pill, the streak
   and points pills, the avatar, then the child's name as a large
   title. Every other screen: the name as a small eyebrow over a large
   screen title, with that screen's actions on the right. */

const VIEW_TITLES = {
    calendar: 'Calendar', rewards: 'Rewards', analytics: 'Analytics', settings: 'Settings',
};

function avatarHtml(profile) {
    const initial = esc((profile?.name || '?').trim().charAt(0).toUpperCase() || '?');
    const label = profile?.name ? `Profiles — showing ${esc(profile.name)}` : 'Profiles';
    return `
        <button class="avatar-btn js-rail-toggle" type="button" aria-label="${label}"
                aria-expanded="${document.body.classList.contains('rail-open')}" aria-controls="rail">
            ${profile?.avatar_path
                ? `<img data-storage-path="${esc(profile.avatar_path)}" alt="" hidden><span>${initial}</span>`
                : `<span>${initial}</span>`}
        </button>`;
}

function renderHead() {
    const host = $('#apphead');
    if (!host) return;
    const view = document.body.dataset.view || 'tasks';
    const profile = activeProfile();
    const name = profile?.name || '';

    if (view === 'tasks') {
        const counts = completionsByDay();
        const label = viewDate().toLocaleDateString('en-US',
            { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
        host.innerHTML = `
            <div class="apphead__row">
                <button class="pill pill--date" type="button" id="btn-view-date"
                        aria-label="${isViewingToday() ? 'Today' : 'Showing'}, ${esc(label)}. Choose another day">
                    <span>${esc(label)}</span>
                    <svg width="14" height="14" aria-hidden="true"><use href="#i-chev-down"/></svg>
                </button>
                <input class="visually-hidden" type="date" id="in-view-date" tabindex="-1"
                       max="${todayKey()}" value="${viewKey}" aria-hidden="true">
                ${isViewingToday() ? '' : '<button class="pill pill--today" type="button" id="day-today">Today</button>'}
                <span class="apphead__spacer"></span>
                <span class="pill pill--stat" title="Streak — days in a row">
                    <svg class="pill__flame" width="18" height="18" aria-hidden="true"><use href="#i-flame"/></svg>
                    <span class="visually-hidden">Streak:</span>${streakDays(counts)}
                </span>
                <span class="pill pill--stat" id="stat-balance" title="Points available to spend">
                    <svg class="pill__star" width="17" height="17" aria-hidden="true"><use href="#i-star"/></svg>
                    <span class="visually-hidden">Points:</span>${pointsBalance()}
                </span>
                ${avatarHtml(profile)}
            </div>
            <h1 class="large-title">${esc(name || 'Tasks')}</h1>`;

        const input = $('#in-view-date');
        $('#btn-view-date').addEventListener('click', () => {
            try { input.showPicker(); } catch { input.focus(); input.click(); }
        });
        input.addEventListener('change', () => {
            const v = input.value;
            if (!v) return;
            // Never past today — completing a future task would bank
            // points for work nobody has done yet (the app blocks it too).
            viewKey = v > todayKey() ? todayKey() : v;
            renderAll();
        });
        $('#day-today')?.addEventListener('click', () => { viewKey = todayKey(); renderAll(); });
    } else if (view === 'settings') {
        const h = settingsHeader();
        host.innerHTML = `
            ${h.back ? `<button class="back-link" type="button" id="btn-set-back">
                <svg width="13" height="22" viewBox="0 0 13 22" aria-hidden="true"><path d="M11 2 2 11l9 9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                ${esc(h.back)}</button>` : ''}
            <div class="apphead__row apphead__row--titled">
                <div class="apphead__titles"><h1 class="large-title">${esc(h.title)}</h1></div>
                <div class="apphead__actions">${h.back ? '' : avatarHtml(profile)}</div>
            </div>`;
        $('#btn-set-back')?.addEventListener('click', settingsBack);
    } else {
        const actions = view === 'rewards'
            ? `<button class="icon-btn" type="button" id="btn-reward-history" aria-label="History">
                   <svg width="22" height="22" aria-hidden="true"><use href="#i-history"/></svg></button>
               <button class="icon-btn" type="button" id="btn-reward-new" aria-label="New reward">
                   <svg width="22" height="22" aria-hidden="true"><use href="#i-plus"/></svg></button>`
            : '';
        host.innerHTML = `
            <div class="apphead__row apphead__row--titled">
                <div class="apphead__titles">
                    ${name ? `<p class="eyebrow">${esc(name)}</p>` : ''}
                    <h1 class="large-title">${VIEW_TITLES[view] || ''}</h1>
                </div>
                <div class="apphead__actions">${actions}${avatarHtml(profile)}</div>
            </div>`;
        $('#btn-reward-history')?.addEventListener('click', () =>
            $('#reward-history')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        $('#btn-reward-new')?.addEventListener('click', () => openRewardModal(null));
    }
    hydrateImages(host);
}

/* One row per profile: the chip switches, the ⋯ opens the things you do
   TO that profile. Sharing used to sit in the Setup view, two clicks and
   one mental model away from the profile it applied to; a menu hanging
   off the profile itself needs no explanation about which one it means. */
function renderProfiles() {
    const host = $('#profile-switcher');
    const userId = state.session?.user?.id;

    host.innerHTML = state.profiles.map((p) => {
        const owned = p.owner_user_id === userId;
        const initial = esc((p.name || '?').trim().charAt(0).toUpperCase() || '?');
        const active = p.id === state.activeProfileId;
        return `
        <div class="profile-row${active ? ' is-active' : ''}" data-row="${esc(p.id)}">
            <button class="profile-chip" type="button" data-profile="${esc(p.id)}"
                    aria-pressed="${active}">
                <span class="profile-chip__avatar">
                    ${p.avatar_path
                        ? `<img data-storage-path="${esc(p.avatar_path)}" alt="" hidden><span>${initial}</span>`
                        : `<span>${initial}</span>`}
                </span>
                <span class="profile-chip__name">${esc(p.name || 'Profile')}</span>
            </button>
            <button class="profile-more" type="button" data-more="${esc(p.id)}"
                    aria-haspopup="menu" aria-expanded="false"
                    aria-label="Options for ${esc(p.name || 'profile')}">
                <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true">
                    <circle cx="10" cy="4.6" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="10" cy="15.4" r="1.5"/>
                </svg>
            </button>
            <div class="profile-menu" role="menu" hidden>
                <button class="profile-menu__item" type="button" role="menuitem" data-menu-edit="${esc(p.id)}">
                    Edit profile…
                </button>
                ${owned
                    ? `<button class="profile-menu__item" type="button" role="menuitem" data-menu-share="${esc(p.id)}">
                           Who has access…
                       </button>`
                    : '<p class="profile-menu__note">Shared with you</p>'}
            </div>
        </div>`;
    }).join('');

    const closeMenus = closeProfileMenus;
    const byId = (id) => state.profiles.find((p) => p.id === id);

    host.querySelectorAll('[data-profile]').forEach((btn) => {
        btn.addEventListener('click', () => {
            closeMenus();
            selectProfile(btn.dataset.profile);
            // Same reason as the nav items: the choice is made, get out of the way.
            setRail(false);
        });
    });

    host.querySelectorAll('[data-more]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const row = btn.closest('.profile-row');
            const menu = row.querySelector('.profile-menu');
            const opening = menu.hidden;
            closeMenus(row);
            menu.hidden = !opening;
            row.classList.toggle('is-menu-open', opening);
            btn.setAttribute('aria-expanded', String(opening));
            if (opening) menu.querySelector('.profile-menu__item')?.focus();
        });
    });

    host.querySelectorAll('[data-menu-edit]').forEach((b) =>
        b.addEventListener('click', () => { closeMenus(); openProfileModal(byId(b.dataset.menuEdit)); }));
    host.querySelectorAll('[data-menu-share]').forEach((b) =>
        b.addEventListener('click', () => { closeMenus(); openShareModal(byId(b.dataset.menuShare)); }));

    hydrateImages(host);
}

/* Bound once in bindAppUI rather than per render — the rows are replaced
   on every profile switch, but the document is not. */
function closeProfileMenus(except) {
    document.querySelectorAll('#profile-switcher .profile-row').forEach((row) => {
        if (row === except) return;
        row.classList.remove('is-menu-open');
        const menu = row.querySelector('.profile-menu');
        if (menu) menu.hidden = true;
        row.querySelector('.profile-more')?.setAttribute('aria-expanded', 'false');
    });
}

/* Re-renders "the summary" after a write. The summary used to be a
   strip of stat tiles; it is the header's streak and points pills now. */
function renderStats() {
    renderHead();
}

/* ── Time of day ───────────────────────────────────────
   The app splits the list into period tiles (Morning / Afternoon /
   Evening by default) and shows one period at a time, tinted with that
   period's own colour. Periods are per-profile data with their own
   name, colour and SF Symbol, so everything here reads from the row;
   the glyph map only translates the symbol name into a drawing. */

const ANYTIME_COLOR = '#F0918F';

const PERIOD_GLYPHS = {
    'sunrise.fill': 'i-sunrise', sunrise: 'i-sunrise',
    'sun.max.fill': 'i-sun', 'sun.max': 'i-sun', 'sun.min.fill': 'i-sun',
    'sunset.fill': 'i-sunset', sunset: 'i-sunset',
    'moon.stars.fill': 'i-moon', 'moon.fill': 'i-moon', 'moon.stars': 'i-moon', moon: 'i-moon',
};
const PERIOD_EMOJI = {
    'cup.and.saucer.fill': '☕', 'briefcase.fill': '💼', 'house.fill': '🏠', 'figure.walk': '🚶',
    'book.fill': '📚', 'gamecontroller.fill': '🎮', 'tv.fill': '📺', 'bed.double.fill': '🛏️',
};
/* The app's built-in names, both languages — TimePeriod.builtInPeriodKey. */
const BUILTIN_BY_NAME = {
    morning: 'i-sunrise', morgunn: 'i-sunrise',
    afternoon: 'i-sun', 'eftirmiðdagur': 'i-sun',
    evening: 'i-moon', 'kvöld': 'i-moon',
};

function glyphSvg(id) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#${id}"/></svg>`;
}

function periodGlyph(period) {
    if (!period) return glyphSvg('i-clock');
    const icon = (period.icon || '').trim();
    if (PERIOD_GLYPHS[icon]) return glyphSvg(PERIOD_GLYPHS[icon]);
    if (PERIOD_EMOJI[icon]) return `<span class="emoji" aria-hidden="true">${PERIOD_EMOJI[icon]}</span>`;
    const byName = BUILTIN_BY_NAME[(period.name || '').trim().toLowerCase()];
    if (byName) return glyphSvg(byName);
    if (icon && !/^[a-z0-9.]+$/i.test(icon)) return `<span class="emoji" aria-hidden="true">${esc(icon)}</span>`;
    return glyphSvg('i-clock');
}

function inPeriodHours(p, hour) {
    const s = p.start_hour ?? 0, e = p.end_hour ?? 0;
    if (s < e) return hour >= s && hour < e;
    if (s > e) return hour >= s || hour < e;
    return true;
}

function visibleTasks() {
    // Only what is scheduled for the day on screen, as in the app.
    return state.data.tasks.filter((t) => isScheduledOn(t, viewDate()));
}

function periodTiles() {
    const vis = visibleTasks();
    const tiles = [...state.data.timePeriods]
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((p) => ({
            id: p.id,
            name: p.name || 'Period',
            color: safeColor(p.color),
            period: p,
            tasks: vis.filter((t) => t.time_period_id === p.id),
        }));
    const known = new Set(state.data.timePeriods.map((p) => p.id));
    const loose = vis.filter((t) => !t.time_period_id || !known.has(t.time_period_id));
    if (loose.length || !tiles.length) {
        tiles.push({ id: 'none', name: 'Anytime', color: ANYTIME_COLOR, period: null, tasks: loose });
    }
    return tiles;
}

/* Which tile to open on. Remembered while you click around; otherwise
   the one the clock is in (as the app does), then the first period
   with something left to do. */
function resolvePeriodSel(tiles) {
    if (tiles.some((t) => t.id === state.periodSel)) return state.periodSel;
    const hour = new Date().getHours();
    const now = isViewingToday()
        ? tiles.filter((t) => t.period && inPeriodHours(t.period, hour)) : [];
    const pick = now.find((t) => t.tasks.length)
        || tiles.find((t) => t.tasks.some((x) => !isCompletedOn(x, viewKey)))
        || tiles.find((t) => t.tasks.length)
        || now[0]
        || tiles[0];
    state.periodSel = pick?.id ?? null;
    return state.periodSel;
}

function selectedTile() {
    const tiles = periodTiles();
    const id = resolvePeriodSel(tiles);
    return { tiles, tile: tiles.find((t) => t.id === id) };
}

/* Play routine plays the selected period, like the app — not every
   unfinished task in the day. */
function doQueueForSelected() {
    const { tile } = selectedTile();
    return (tile?.tasks || []).filter((t) => !isCompletedOn(t, viewKey));
}

function taskIconHtml(task) {
    return task.image_path
        ? `<img data-storage-path="${esc(task.image_path)}" alt="" hidden><span>${iconFor(task)}</span>`
        : iconFor(task);
}

function taskRowHtml(task) {
    const done = isCompletedOn(task, viewKey);
    const steps = state.data.subtasks.filter((s) => s.task_id === task.id);
    const stepsDone = steps.filter((s) => s.is_completed).length;
    const due = task.due_date ? new Date(task.due_date) : null;
    const overdue = due && !done && dayKey(due) < todayKey();

    const meta = [];
    if (steps.length) meta.push(`<span>${stepsDone}/${steps.length} steps</span>`);
    if (due) {
        meta.push(`<span class="${overdue ? 'is-overdue' : ''}">${overdue ? 'Overdue · ' : 'Due '}${fmtDate(due, { day: 'numeric', month: 'short' })}</span>`);
    }

    return `
        <div class="trow${done ? ' is-done' : ''}">
            <button class="trow__main" type="button" data-edit="${esc(task.id)}" aria-label="Edit ${esc(task.title)}">
                <span class="trow__icon" aria-hidden="true">${taskIconHtml(task)}</span>
                <span class="trow__text">
                    <span class="trow__title">${esc(task.title)}</span>
                    ${meta.length ? `<span class="trow__meta">${meta.join('')}</span>` : ''}
                </span>
            </button>
            ${task.points ? `<span class="trow__pts" aria-label="${task.points} points">
                <svg width="14" height="14" aria-hidden="true"><use href="#i-star"/></svg>${task.points}</span>` : ''}
            <button class="trow__check${done ? ' is-done' : ''}" type="button" data-toggle="${esc(task.id)}"
                    aria-pressed="${done}" aria-label="${done ? 'Mark not done' : 'Mark done'}: ${esc(task.title)}">
                ${done ? '<svg width="30" height="30" aria-hidden="true"><use href="#i-check"/></svg>' : ''}
            </button>
        </div>`;
}

function renderTasks() {
    const host = $('#task-groups');
    const tilesHost = $('#period-tiles');
    const progressHost = $('#task-progress');
    if (!host) return;

    const { tiles, tile } = selectedTile();
    document.documentElement.style.setProperty('--period', tile?.color || ANYTIME_COLOR);

    tilesHost.innerHTML = tiles.map((t) => {
        const sel = t.id === tile?.id;
        return `
            <button class="ptile${sel ? ' is-selected' : ''}" type="button" data-period="${esc(t.id)}"
                    aria-pressed="${sel}" style="--pc:${t.color}">
                <span class="ptile__icon">${periodGlyph(t.period)}</span>
                <span class="ptile__name">${esc(t.name)}</span>
            </button>`;
    }).join('');
    tilesHost.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => {
        state.periodSel = b.dataset.period;
        renderTasks();
    }));

    const tasks = tile?.tasks || [];
    const doneCount = tasks.filter((t) => isCompletedOn(t, viewKey)).length;
    progressHost.innerHTML = tasks.length
        ? `<div class="segments__track" role="img" aria-label="${doneCount} of ${tasks.length} done">
               ${tasks.map((t) => `<span class="seg${isCompletedOn(t, viewKey) ? ' is-done' : ''}"></span>`).join('')}
           </div>`
        : '';

    if (!state.data.tasks.length) {
        host.innerHTML = `
            <div class="empty empty--tasks">
                <img src="../assets/mascot/loa-sleeping.svg" alt="">
                <strong>No tasks yet</strong>
                <p>Tap + to add one, or create tasks in the Vigdís app.</p>
            </div>`;
    } else if (!tasks.length) {
        host.innerHTML = `
            <div class="empty empty--tasks">
                <img src="../assets/mascot/loa-sleeping.svg" alt="">
                <strong>Nothing in ${esc(tile?.name || 'this period')}${isViewingToday() ? ' today' : ' that day'}</strong>
                <p>Pick another time of day above, or tap + to add a task here.</p>
            </div>`;
    } else {
        host.innerHTML = `<div class="task-list">${tasks.map(taskRowHtml).join('')}</div>`;
    }

    host.querySelectorAll('[data-toggle]').forEach((btn) => {
        btn.addEventListener('click', () => toggleTask(btn.dataset.toggle));
    });
    host.querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', () => openTaskModal(btn.dataset.edit));
    });
    hydrateImages(host);
}

/* ── Rewards ───────────────────────────────────────────
   The app's Rewards tab: a coral balance card with today's earnings and
   the next goal, then one card per reward. */

/* Points banked on one day — completions at their snapshot value plus
   any bonus points awarded that day. */
function earnedOn(key) {
    let pts = 0;
    for (const t of state.data.tasks) {
        for (const ts of t.completion_history || []) {
            if (dayKey(ts) === key) pts += pointsAwarded(t, ts);
        }
    }
    for (const b of state.data.bonus) if (dayKey(b.date) === key) pts += b.amount || 0;
    return pts;
}

function rewardIconHtml(r) {
    const icon = iconFor(r) || '🎁';
    return r.image_path
        ? `<img data-storage-path="${esc(r.image_path)}" alt="" hidden><span>${icon}</span>`
        : icon;
}

function renderRewards() {
    const host = $('#rewards-list');
    const balanceHost = $('#reward-balance');
    if (!host) return;
    const balance = pointsBalance();
    const today = earnedOn(todayKey());
    const rewards = [...state.data.rewards].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const goal = rewards.filter((r) => (r.cost || 0) > balance).sort((a, b) => a.cost - b.cost)[0];

    let goalHtml = '';
    if (goal) {
        const pct = Math.max(2, Math.min(100, Math.round((balance / goal.cost) * 100)));
        goalHtml = `
            <div class="goal">
                <span class="goal__tile" aria-hidden="true">${rewardIconHtml(goal)}</span>
                <div class="goal__body">
                    <p class="goal__label">Next goal</p>
                    <p class="goal__name">${esc(goal.title)}</p>
                    <div class="goal__bar" role="img" aria-label="${balance} of ${goal.cost} points">
                        <span style="width:${pct}%"></span>
                    </div>
                    <p class="goal__left">${goal.cost - balance} to go</p>
                </div>
            </div>`;
    } else if (rewards.length) {
        goalHtml = `
            <div class="goal">
                <span class="goal__tile" aria-hidden="true">🎉</span>
                <div class="goal__body">
                    <p class="goal__label">Next goal</p>
                    <p class="goal__name">Every reward is in reach</p>
                    <div class="goal__bar" role="img" aria-label="Enough points for every reward"><span style="width:100%"></span></div>
                </div>
            </div>`;
    }

    balanceHost.innerHTML = `
        <section class="balance" aria-label="Points balance">
            <p class="balance__label">Your balance</p>
            <p class="balance__value"><span>${balance}</span> points</p>
            ${today > 0 ? `<span class="balance__chip">↑ +${today} today</span>` : ''}
            ${goalHtml}
        </section>`;

    if (!rewards.length) {
        host.innerHTML = `
            <div class="card empty">
                <strong>No rewards yet</strong>
                <p>Add something worth saving points for — it appears in the app straight away.</p>
                <button class="btn-primary btn-primary--inline" type="button" id="btn-reward-empty-add">Add a reward</button>
            </div>`;
        $('#btn-reward-empty-add')?.addEventListener('click', () => openRewardModal(null));
        hydrateImages(balanceHost);
        return;
    }

    host.innerHTML = rewards.map((r) => {
        const need = (r.cost || 0) - balance;
        return `
        <div class="rcard">
            <button class="rcard__tile" type="button" data-reward-open="${esc(r.id)}"
                    aria-label="Edit ${esc(r.title)}">${rewardIconHtml(r)}</button>
            <div class="rcard__body">
                <p class="rcard__name">${esc(r.title)}</p>
                <div class="rcard__foot">
                    <span class="rcard__cost"><svg width="17" height="17" aria-hidden="true"><use href="#i-star"/></svg>${r.cost || 0}</span>
                    <button class="redeem-btn" type="button" data-redeem="${esc(r.id)}"
                            ${need > 0 ? `disabled title="Needs ${need} more points"` : ''}>
                        ${need > 0 ? `${need} to go` : 'Redeem <span aria-hidden="true">→</span>'}
                    </button>
                </div>
            </div>
        </div>`;
    }).join('');
    host.querySelectorAll('[data-redeem]').forEach((btn) => {
        btn.addEventListener('click', () => redeemReward(btn.dataset.redeem, btn));
    });
    host.querySelectorAll('[data-reward-open]').forEach((btn) => {
        btn.addEventListener('click', () => openRewardModal(
            state.data.rewards.find((r) => r.id === btn.dataset.rewardOpen)));
    });
    hydrateImages(host);
    hydrateImages(balanceHost);
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
    if (!$('[data-pane="analytics"]')?.hidden) { renderAnalytics(); renderReport(); }
    renderHead();
    renderSettings();
    renderProfiles();
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
        points: Math.max(0, parseInt($('#quick-add-points')?.value, 10) || 0),
        task_type: 'regular',
        behavior_type: 'regular',
        icon: $('#quick-add-icon')?.value.trim() || '📝',
        tags: [],
        sort_order: sortMax + 1,
        time_period_id: $('#quick-add-period')?.value || null,
    };
    // Land on the period the task went into, so it is visibly there.
    state.periodSel = row.time_period_id || 'none';
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
    state.periodSel = null;
    /* Wear this profile's theme. Applied before the data loads so the
       skeletons below are already the right colour — switching child and
       watching the page recolour a beat later would look like a glitch. */
    applyProfileTheme(state.profiles.find((p) => p.id === profileId));
    renderProfiles();
    if (DEMO) { state.data = demoData(profileId); renderAll(); return; }
    if (skeleton) {
        $('#task-groups').innerHTML = '<div class="skeleton"></div>'.repeat(3);
        $('#period-tiles').innerHTML = '';
        $('#task-progress').innerHTML = '';
        $('#rewards-list').innerHTML = '<div class="skeleton"></div>';
        $('#activity-list').innerHTML = '<div class="skeleton"></div>';
    }
    await loadProfileData(profileId);
    renderAll();
    subscribeRealtime(profileId);
}

/* Hand the setup module its dependencies once, on the way in. It needs
   the client and the shared state, and `refresh` so a write re-reads and
   re-renders through the same path the rest of the page uses rather than
   keeping its own copy of the data.

   Demo mode calls this too. It used not to, which meant manage.js ran
   with an undefined `$` and the very first call in renderAll threw —
   taking the greeting, the stats and the task list with it. A preview
   that renders an empty shell is worse than no preview. */
function wireManagement() {
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
        /* Play routine plays the selected time of day. */
        getDoQueue: doQueueForSelected,
        refresh: async () => {
            if (DEMO) { renderAll(); return; }
            if (state.activeProfileId) await loadProfileData(state.activeProfileId);
            renderAll();
        },
    });

    initSettings({
        state, sb, esc, toast, DEMO, hydrateImages, exportCSV, signOut, selectProfile,
        renderAll, renderHead,
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
}

async function enterApp() {
    showView('view-app');
    $('#user-email').textContent = state.session?.user?.email || '';
    wireManagement();

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
        $('#period-tiles').innerHTML = '';
        $('#task-progress').innerHTML = '';
        $('#task-groups').innerHTML = `
            <div class="empty">
                <img src="../assets/mascot/loa-sleeping.svg" alt="">
                <strong>No cloud profiles found</strong>
                <p>Open the Vigdís app, turn on Cloud Sync in Settings, and your family's data will appear here.</p>
            </div>`;
        $('#rewards-list').innerHTML = '';
        $('#activity-list').innerHTML = '';
        renderHead();
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
            setView('tasks');
            renderAll();
        });
    });
}

/* ── Analytics (app-style cards) ───────────────────────
 *
 * The four cards at the top of the app's Analytics tab: routines done
 * this week, the tasks that need a hand, the eight-week trend, and time
 * of day. All derived from completion_history already in memory.
 *
 * "Due" here is stricter than isScheduledOn: a one-off with no date
 * stays on the list until it is done, but it is not *due* every day, so
 * counting it would mark a child down for every day before they did it.
 * Days before the profile's first recorded completion are not counted
 * either — the same clamp the detailed report uses.
 */

const MS_DAY = 86400000;
const addDaysKey = (key, n) => dayKey(new Date(Date.parse(key + 'T12:00:00Z') + n * MS_DAY));
const WD_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WD_SHORT_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function firstHistoryKey() {
    let first = null;
    for (const t of state.data.tasks) {
        for (const ts of t.completion_history || []) {
            const k = dayKey(ts);
            if (!first || k < first) first = k;
        }
    }
    return first;
}

function isDueOn(task, key) {
    const hasRec = Array.isArray(task.recurrence_days) && task.recurrence_days.length > 0;
    if (!task.due_date && !hasRec) return false;
    if (task.created_at && dayKey(task.created_at) > key) return false;
    return isScheduledOn(task, new Date(key + 'T12:00:00Z'));
}

/* A routine is one time period's tasks on one day; it counts as done
   when every task due in it that day was ticked off. */
function routinesOn(key) {
    const groups = new Map();
    for (const t of state.data.tasks) {
        if (!isDueOn(t, key)) continue;
        const g = t.time_period_id || 'none';
        const cur = groups.get(g) || { due: 0, done: 0 };
        cur.due += 1;
        if (isCompletedOn(t, key)) cur.done += 1;
        groups.set(g, cur);
    }
    let total = 0, done = 0;
    for (const g of groups.values()) { total += 1; if (g.done === g.due) done += 1; }
    return { total, done };
}

/* Completion rate of due tasks between two keys (inclusive). */
function dueRate(tasks, fromKey, toKey) {
    let due = 0, done = 0;
    for (let k = fromKey; k <= toKey; k = addDaysKey(k, 1)) {
        for (const t of tasks) {
            if (!isDueOn(t, k)) continue;
            due += 1;
            if (isCompletedOn(t, k)) done += 1;
        }
    }
    return { due, done, rate: due ? done / due : null };
}

function renderAnalytics() {
    const host = $('#analytics-top');
    if (!host) return;
    const today = todayKey();
    const start = firstHistoryKey();

    if (!start) {
        host.innerHTML = `
            <section class="card empty an-span">
                <img src="../assets/mascot/loa-sleeping.svg" alt="">
                <strong>Nothing to show yet</strong>
                <p>Tick a few tasks off and this fills with how the routines are going.</p>
            </section>`;
        return;
    }
    const clamp = (k) => (k < start ? start : k);

    /* ── Routines done — this week, Monday first ── */
    const wd = new Date(today + 'T12:00:00Z').getUTCDay();
    const monday = addDaysKey(today, -((wd + 6) % 7));
    let wTotal = 0, wDone = 0;
    const bars = [];
    for (let i = 0; i < 7; i++) {
        const k = addDaysKey(monday, i);
        const future = k > today;
        const r = future || k < start ? { total: 0, done: 0 } : routinesOn(k);
        wTotal += r.total; wDone += r.done;
        bars.push({
            letter: WD_LETTER[new Date(k + 'T12:00:00Z').getUTCDay()],
            ratio: r.total ? r.done / r.total : 0,
            isToday: k === today,
            label: future ? 'still to come' : `${r.done} of ${r.total}`,
        });
    }
    const weekPct = wTotal ? Math.round((wDone / wTotal) * 100) : null;

    /* ── Needs a hand — last four weeks ── */
    const from28 = clamp(addDaysKey(today, -27));
    const struggling = [];
    for (const t of state.data.tasks) {
        let due = 0, done = 0;
        const byWd = Array.from({ length: 7 }, () => ({ due: 0, done: 0 }));
        for (let k = from28; k <= today; k = addDaysKey(k, 1)) {
            if (!isDueOn(t, k)) continue;
            const w = new Date(k + 'T12:00:00Z').getUTCDay();
            due += 1; byWd[w].due += 1;
            if (isCompletedOn(t, k)) { done += 1; byWd[w].done += 1; }
        }
        if (due < 3 || done === due) continue;
        let hardest = null, worst = 2;
        byWd.forEach((d, w) => {
            if (!d.due || d.done === d.due) return;
            const r = d.done / d.due;
            if (r < worst) { worst = r; hardest = w; }
        });
        struggling.push({ task: t, due, done, rate: done / due, hardest });
    }
    struggling.sort((a, b) => a.rate - b.rate || b.due - a.due);
    const handRows = struggling.slice(0, 3);

    /* ── Last 8 weeks — rolling 7-day windows ending today ── */
    const weeks = [];
    for (let w = 7; w >= 0; w--) {
        const end = addDaysKey(today, -7 * w);
        const begin = addDaysKey(end, -6);
        const r = end < start ? { rate: null } : dueRate(state.data.tasks, clamp(begin), end);
        weeks.push({
            rate: r.rate,
            label: new Date(begin + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
        });
    }
    const rated = weeks.filter((w) => w.rate != null);
    let trendTitle = 'Building up', chip = '';
    if (rated.length >= 2) {
        const half = Math.floor(rated.length / 2);
        const avg = (arr) => arr.reduce((s, w) => s + w.rate, 0) / arr.length;
        const earlier = avg(rated.slice(0, half));
        const recent = avg(rated.slice(rated.length - half));
        const change = earlier > 0 ? Math.round(((recent - earlier) / earlier) * 100) : null;
        if (change == null) trendTitle = recent > 0 ? 'Getting started' : 'Building up';
        else if (change >= 5) trendTitle = 'Getting easier';
        else if (change <= -5) trendTitle = 'A harder stretch';
        else trendTitle = 'Holding steady';
        if (change != null && change !== 0) {
            chip = `<span class="delta-chip ${change > 0 ? 'is-up' : 'is-down'}">${change > 0 ? '↑' : '↓'}${Math.abs(change)}%</span>`;
        }
    }

    /* ── Time of day — last four weeks ── */
    const periodRows = periodTiles().map((tile) => {
        const ids = tile.period ? [tile.period.id] : null;
        const tasks = state.data.tasks.filter((t) => (ids
            ? t.time_period_id === ids[0]
            : !t.time_period_id || !state.data.timePeriods.some((p) => p.id === t.time_period_id)));
        return { tile, ...dueRate(tasks, from28, today) };
    }).filter((r) => r.due > 0);

    const pct = (r) => `${Math.round(r * 100)}%`;

    host.innerHTML = `
        <section class="card an-card" aria-labelledby="an-routines">
            <div class="card__head">
                <h2 class="eyebrow" id="an-routines">Routines done</h2>
            </div>
            <p class="an-big">${weekPct == null ? '—' : `${weekPct}%`}</p>
            <p class="an-sub">${wDone} of ${wTotal} this week</p>
            <div class="daybars" role="img" aria-label="Routines done each day this week">
                ${bars.map((b) => `
                    <div class="daybars__col" title="${b.label}">
                        <div class="daybars__track"><span style="height:${b.ratio ? Math.max(10, Math.round(b.ratio * 100)) : 0}%"></span></div>
                        <span class="daybars__day${b.isToday ? ' is-today' : ''}">${b.letter}</span>
                    </div>`).join('')}
            </div>
        </section>

        <section class="card an-card" aria-labelledby="an-hand">
            <div class="card__head">
                <h2 class="eyebrow" id="an-hand">Needs a hand</h2>
                <button class="see-all" type="button" id="btn-see-all">See all
                    <svg width="14" height="14" aria-hidden="true"><use href="#i-chev-right"/></svg></button>
            </div>
            ${handRows.length ? `<ul class="hand-list">${handRows.map((h) => `
                <li class="hand-row">
                    <span class="hand-row__tile" aria-hidden="true">${iconFor(h.task)}</span>
                    <span class="hand-row__body">
                        <span class="hand-row__title">${esc(h.task.title)}</span>
                        <span class="hand-row__meta">${h.done} of ${h.due}${h.hardest != null ? ` · hardest: ${WD_SHORT_NAME[h.hardest]}` : ''}</span>
                    </span>
                    <span class="hand-row__pct">${pct(h.rate)}</span>
                </li>`).join('')}</ul>`
                : '<p class="an-quiet">Every routine task landed on the days it was due. Nothing needs a hand right now.</p>'}
            <p class="an-foot">Last 4 weeks</p>
        </section>

        <section class="card an-card" aria-labelledby="an-weeks">
            <p class="eyebrow">Last 8 weeks</p>
            <div class="card__head card__head--tight">
                <h2 class="an-title" id="an-weeks">${trendTitle}</h2>
                ${chip}
            </div>
            <div class="weekbars" role="img" aria-label="Share of due tasks done, each of the last 8 weeks">
                <div class="weekbars__grid" aria-hidden="true">
                    <span data-l="100%"></span><span data-l="50%"></span><span data-l="0%"></span>
                </div>
                <div class="weekbars__cols">
                    ${weeks.map((w, i) => `
                        <div class="weekbars__col${i === weeks.length - 1 ? ' is-latest' : ''}"
                             title="${w.label}: ${w.rate == null ? 'no data' : pct(w.rate)}">
                            <div class="weekbars__track"><span style="height:${w.rate == null ? 0 : Math.max(3, Math.round(w.rate * 100))}%"></span></div>
                            <span class="weekbars__label">${i % 2 === 1 ? w.label : '&nbsp;'}</span>
                        </div>`).join('')}
                </div>
            </div>
        </section>

        <section class="card an-card" aria-labelledby="an-tod">
            <div class="card__head">
                <h2 class="eyebrow" id="an-tod">Time of day</h2>
            </div>
            ${periodRows.length ? `<ul class="tod-list">${periodRows.map((r) => `
                <li class="tod-row" style="--pc:${r.tile.color}">
                    <span class="tod-row__icon">${periodGlyph(r.tile.period)}</span>
                    <span class="tod-row__name">${esc(r.tile.name)}</span>
                    <span class="tod-row__pct">${pct(r.rate)}</span>
                    <span class="tod-row__bar"><span style="width:${Math.round(r.rate * 100)}%"></span></span>
                </li>`).join('')}</ul>`
                : '<p class="an-quiet">No repeating tasks in the last four weeks yet.</p>'}
            <p class="an-foot">Last 4 weeks</p>
        </section>`;

    $('#btn-see-all')?.addEventListener('click', () =>
        $('#reliability-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

/* ── Statistics ────────────────────────────────────────
   Answers the questions a review actually asks: is this working overall,
   which steps are reliable, which are consistently the hard ones, and
   when in the day does it fall apart. Per-task reliability is the one
   most worth having — it turns "they're struggling" into "getting
   dressed works four days in five, teeth are the problem". */
/* ── Statistics ────────────────────────────────────────
 *
 * This screen used to be three grey boxes, a stretched area chart and
 * two identical bar charts, in one flat panel. It reported numbers
 * without ever answering the question a parent brings to it: is this
 * working, and if not, where is it failing?
 *
 * So it is built around four answers now — how much, how consistently,
 * what changed since last time, and what stands out — each in its own
 * card, with the raw per-task ranking kept at the bottom for the
 * review-and-evidence case (an IEP meeting, a specialist appointment)
 * that the CSV export also serves.
 *
 * Every number is derived from data already loaded, so changing the
 * range costs no request.
 */

/* The range chips replace a native <select>. It is three options that
   never grow; a dropdown to choose between three things is a click and
   a menu where two clicks-worth of buttons fit on one line. */
let reportRange = 30;

function completionsBetween(fromKey, toKey) {
    let n = 0;
    let points = 0;
    for (const t of state.data.tasks) {
        for (const ts of t.completion_history || []) {
            const k = dayKey(ts);
            if (k < fromKey || k > toKey) continue;
            n += 1;
            points += pointsAwarded(t, ts);
        }
    }
    return { n, points };
}

/** Rolling mean over `win` days, aligned to the right so each point is
 *  "the average of the week ending here". The first few points average
 *  fewer days rather than being dropped — a chart that starts a week
 *  late looks like missing data. */
function rollingMean(values, win = 7) {
    return values.map((_, i) => {
        const from = Math.max(0, i - win + 1);
        const slice = values.slice(from, i + 1);
        return slice.reduce((a, b) => a + b, 0) / slice.length;
    });
}

/** A change against the previous window of the same length. Returns
 *  null when there is no previous window to compare with, which is not
 *  the same as "no change" and must not be drawn as 0%. */
function deltaBadge(current, previous) {
    if (previous == null) return '';
    if (previous === 0 && current === 0) return '';
    if (previous === 0) return '<span class="delta is-up">new</span>';
    const pct = Math.round(((current - previous) / previous) * 100);
    if (pct === 0) return '<span class="delta is-flat">level</span>';
    const up = pct > 0;
    return `<span class="delta ${up ? 'is-up' : 'is-down'}">${up ? '↑' : '↓'} ${Math.abs(pct)}%</span>`;
}

function renderReport() {
    const host = $('#report-body');
    if (!host) return;
    const days = reportRange;

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

    if (!allDates.length) {
        host.innerHTML = `
            <section class="panel">
                <div class="empty">
                    <img src="../assets/mascot/loa-sleeping.svg" alt="">
                    <strong>Nothing to report yet</strong>
                    <p>Tick a few tasks off and this fills with what is working
                       and what is slipping.</p>
                </div>
            </section>`;
        return;
    }

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

    /* With a short list, a "best five" and a "worst five" are the same
       five tasks printed twice, which reads as a rendering fault. Below
       ten, show one ranked list; above it, split into two that cannot
       overlap. */
    let taskSections;
    if (ranked.length === 0) {
        taskSections = reliabilityRows([]);
    } else if (ranked.length < 10) {
        taskSections = `<h3 class="rhead">Every task · most to least reliable</h3>
            ${reliabilityRows(ranked)}`;
    } else {
        taskSections = `<h3 class="rhead">Most reliable</h3>
            ${reliabilityRows(ranked.slice(0, 5))}
            <h3 class="rhead">Needs the most support</h3>
            ${reliabilityRows(ranked.slice(-5).reverse())}`;
    }

    const periodRows = [...byPeriod.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);

    /* Per-day series for the trend chart. Built across the whole span
       including empty days — skipping them would compress gaps and draw
       a rising line through a week nothing happened. */
    const dayCounts = new Map();
    for (const t of state.data.tasks) {
        for (const ts of (t.completion_history || [])) {
            if (!inRange(ts)) continue;
            const k = dayKey(ts);
            dayCounts.set(k, (dayCounts.get(k) || 0) + 1);
        }
    }
    const series = [];
    for (let i = 0; i < spanDays; i += 1) {
        const d = new Date(Date.parse(sinceKey) + i * 86400000);
        const k = dayKey(d);
        series.push({
            label: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
            value: dayCounts.get(k) || 0,
        });
    }
    const average = spanDays >= 10 ? rollingMean(series.map((d) => d.value), 7) : null;

    /* Weekday pattern. Sunday-first to match the app's `appWeekday`,
       relabelled Mon-first for reading because a week starting Monday
       is what a school routine actually looks like. */
    const WD_ORDER = [2, 3, 4, 5, 6, 7, 1];
    const WD_LABEL = { 1: 'Sun', 2: 'Mon', 3: 'Tue', 4: 'Wed', 5: 'Thu', 6: 'Fri', 7: 'Sat' };
    const WD_FULL = { 1: 'Sundays', 2: 'Mondays', 3: 'Tuesdays', 4: 'Wednesdays', 5: 'Thursdays', 6: 'Fridays', 7: 'Saturdays' };
    const byWeekday = new Map(WD_ORDER.map((w) => [w, 0]));
    for (const [k, n] of dayCounts) {
        const w = new Date(k + 'T12:00:00Z').getUTCDay() + 1;
        byWeekday.set(w, (byWeekday.get(w) || 0) + n);
    }
    const weekdayRows = WD_ORDER.map((w) => ({ key: w, label: WD_LABEL[w], value: byWeekday.get(w) || 0 }));

    const perDay = total && activeDays.size ? (total / activeDays.size).toFixed(1) : '0';
    const consistency = Math.round((activeDays.size / spanDays) * 100);
    const pointsEarned = completionsBetween(sinceKey, todayKey()).points
        + state.data.bonus.reduce((s, b) => {
            const k = dayKey(b.date);
            return k >= sinceKey && k <= todayKey() && (b.amount || 0) > 0 ? s + b.amount : s;
        }, 0);

    /* The previous window of the same length, for the deltas. Only
       offered when the profile actually has history that far back —
       comparing against days before the profile existed would report a
       collapse every time someone opens a longer range. */
    const prevEnd = dayKey(new Date(Date.parse(sinceKey) - 86400000));
    const prevStart = dayKey(new Date(Date.parse(sinceKey) - spanDays * 86400000));
    const hasPrev = firstEver != null && firstEver <= prevEnd;
    const prev = hasPrev ? completionsBetween(prevStart, prevEnd) : null;
    let prevActive = null;
    if (hasPrev) {
        const set = new Set();
        for (const t of state.data.tasks) {
            for (const ts of t.completion_history || []) {
                const k = dayKey(ts);
                if (k >= prevStart && k <= prevEnd) set.add(k);
            }
        }
        prevActive = Math.round((set.size / spanDays) * 100);
    }

    // Say the window out loud when it was clamped, so 7 of 7 is not read
    // as 7 of 30.
    const windowNote = firstEver && spanDays < days
        ? `Showing ${spanDays} days — that is all the history this profile has.`
        : `${fmtDate(new Date(sinceKey + 'T12:00:00Z'), { day: 'numeric', month: 'short' })} – ${fmtDate(new Date(), { day: 'numeric', month: 'short' })}`;

    /* ── What stands out ──
       Two or three plain sentences, each one a thing you could act on.
       Suppressed below a week of data, where every "pattern" is noise. */
    const insights = [];
    if (total >= 5) {
        const bestDay = [...weekdayRows].sort((a, b) => b.value - a.value)[0];
        const worstDay = [...weekdayRows].sort((a, b) => a.value - b.value)[0];
        if (bestDay.value > 0 && bestDay.value > worstDay.value) {
            insights.push({
                icon: '📅',
                text: `${WD_FULL[bestDay.key]} carry this routine — ${bestDay.value} done. `
                    + `${WD_FULL[worstDay.key]} are the thinnest, at ${worstDay.value}.`,
            });
        }
        if (periodRows.length > 1) {
            insights.push({
                icon: '⏰',
                text: `${periodRows[0][0]} is where most gets done (${Math.round((periodRows[0][1] / total) * 100)}% of everything ticked off).`,
            });
        }
        const struggling = ranked.filter((t) => t.due >= 3).slice(-1)[0];
        if (struggling && struggling.rate < 0.5) {
            insights.push({
                icon: '🎯',
                text: `“${struggling.title}” is landing ${Math.round(struggling.rate * 100)}% of the time — `
                    + 'the one to make easier, move, or drop.',
            });
        }
        if (prev && prev.n > 0) {
            const diff = total - prev.n;
            insights.push({
                icon: diff >= 0 ? '📈' : '📉',
                text: diff === 0
                    ? `Exactly the same as the ${spanDays} days before this one.`
                    : `${Math.abs(diff)} ${diff > 0 ? 'more' : 'fewer'} than the previous ${spanDays} days.`,
            });
        }
    }

    host.innerHTML = `
        <div class="report-kpis">
            <div class="stat">
                <div class="stat__label"><span class="stat__icon" aria-hidden="true">✅</span>Completed</div>
                <div class="stat__value">${total}${deltaBadge(total, prev?.n ?? null)}</div>
                <div class="stat__meta">tasks ticked off</div>
            </div>
            <div class="stat">
                <div class="stat__label"><span class="stat__icon" aria-hidden="true">🎯</span>Consistency</div>
                <div class="stat__value">${consistency}<span class="stat__of">%</span>${deltaBadge(consistency, prevActive)}</div>
                <div class="stat__bar"><span style="width:${consistency}%"></span></div>
                <div class="stat__meta">${activeDays.size} of ${spanDays} days had something done</div>
            </div>
            <div class="stat">
                <div class="stat__label"><span class="stat__icon" aria-hidden="true">📊</span>Per active day</div>
                <div class="stat__value">${perDay}</div>
                <div class="stat__meta">on the days it happened</div>
            </div>
            <div class="stat">
                <div class="stat__label"><span class="stat__icon" aria-hidden="true">⭐</span>Points earned</div>
                <div class="stat__value">${pointsEarned}</div>
                <div class="stat__meta">in this range</div>
            </div>
        </div>

        <p class="report-window">${esc(windowNote)}</p>

        ${insights.length ? `
        <section class="panel panel--insights" aria-labelledby="insight-title">
            <div class="panel__head"><h2 class="panel__title" id="insight-title">What stands out</h2></div>
            <ul class="insights">
                ${insights.map((i) => `
                <li class="insight">
                    <span class="insight__icon" aria-hidden="true">${i.icon}</span>
                    <span>${esc(i.text)}</span>
                </li>`).join('')}
            </ul>
        </section>` : ''}

        <section class="panel" aria-labelledby="trend-title">
            <div class="panel__head">
                <h2 class="panel__title" id="trend-title">Tasks completed each day</h2>
            </div>
            ${trendChart(series, { label: '', average })}
        </section>

        <div class="setup-grid">
            <section class="panel" aria-labelledby="weekday-title">
                <div class="panel__head">
                    <h2 class="panel__title" id="weekday-title">Which days work</h2>
                </div>
                ${barChart(weekdayRows, { label: '' })}
            </section>

            <section class="panel" aria-labelledby="period-title">
                <div class="panel__head">
                    <h2 class="panel__title" id="period-title">By time of day</h2>
                </div>
                ${rankBars(periodRows.map(([name, n]) => ({ label: name, value: n })), { label: '' })}
            </section>
        </div>

        <section class="panel" aria-labelledby="reliability-title">
            <div class="panel__head">
                <h2 class="panel__title" id="reliability-title">Task by task</h2>
                <button class="btn-ghost" id="btn-export-stats" type="button">Export CSV</button>
            </div>
            <p class="rnote">How often each task was done on the days it was actually due.</p>
            ${taskSections}
        </section>`;

    $('#btn-export-stats')?.addEventListener('click', exportCSV);
}

/* The app's five tabs. Old hashes (#statistics, #manage) still land. */
const VIEWS = ['tasks', 'calendar', 'rewards', 'analytics', 'settings'];
const LEGACY_VIEWS = { today: 'tasks', stats: 'analytics', statistics: 'analytics', manage: 'settings' };

function setView(name, pushHash = true) {
    name = LEGACY_VIEWS[name] || name;
    if (!VIEWS.includes(name)) name = 'tasks';
    /* One attribute on <body> lets CSS change the page wash with the
       screen: the period colour on Tasks, the app's soft pink elsewhere. */
    document.body.dataset.view = name;
    document.querySelectorAll('.viewtab').forEach((t) => {
        if (t.dataset.view === name) t.setAttribute('aria-current', 'page');
        else t.removeAttribute('aria-current');
    });
    document.querySelectorAll('.viewpane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
    renderHead();
    if (name === 'calendar') renderCalendar();
    if (name === 'analytics') { renderAnalytics(); renderReport(); }
    if (name === 'settings') { renderManagement(); renderSettings(); }
    // Hash must not collide with an element id or the browser scroll-jumps
    // to it on load. None of these five match an id.
    const hash = name === 'tasks' ? '' : `#${name}`;
    if (pushHash) history.replaceState(null, '', hash || location.pathname + location.search);
}

/* The profile drawer (narrow windows). Opened from the avatar in the
   header; closed by choosing, Escape, the scrim or an outside click. */
function setRail(open) {
    $('#rail')?.classList.toggle('is-open', open);
    document.body.classList.toggle('rail-open', open);
    document.querySelectorAll('.js-rail-toggle').forEach((b) => b.setAttribute('aria-expanded', String(open)));
}

function bindAppUI() {
    const rail = $('#rail');
    bindSettings();
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        setRail(false);
        closeProfileMenus();
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest?.('.profile-row')) closeProfileMenus();
        if (e.target.closest?.('.js-rail-toggle')) {
            setRail(!rail?.classList.contains('is-open'));
            return;
        }
        if (!rail?.classList.contains('is-open')) return;
        if (rail.contains(e.target)) return;
        setRail(false);
    });

    document.querySelectorAll('.viewtab').forEach((t) =>
        t.addEventListener('click', () => {
            // Choosing Settings again pops back to its root, as a tab bar does.
            if (t.dataset.view === 'settings' && document.body.dataset.view === 'settings') resetSettings();
            setView(t.dataset.view);
            setRail(false);
            window.scrollTo({ top: 0 });
        }));
    setView(location.hash.replace('#', '') || 'tasks', false);

    /* + opens the add-task sheet, pre-set to the time of day on screen. */
    $('#btn-open-add')?.addEventListener('click', () => {
        if (!state.activeProfileId) return;
        const sel = state.periodSel && state.periodSel !== 'none' ? state.periodSel : '';
        fillPeriodSelect($('#quick-add-period'), sel);
        $('#in-quick-add').value = '';
        $('#quick-add-icon').value = '';
        $('#quick-add-points').value = '5';
        $('#modal-add').showModal();
        $('#in-quick-add').focus();
    });
    $('#btn-add-cancel')?.addEventListener('click', () => $('#modal-add').close());
    $('#cal-prev')?.addEventListener('click', () => {
        calMonth.setUTCMonth(calMonth.getUTCMonth() - 1); renderCalendar();
    });
    $('#cal-next')?.addEventListener('click', () => {
        calMonth.setUTCMonth(calMonth.getUTCMonth() + 1); renderCalendar();
    });
    document.querySelectorAll('[data-range]').forEach((chip) => {
        chip.addEventListener('click', () => {
            reportRange = Number(chip.dataset.range);
            document.querySelectorAll('[data-range]').forEach((c) =>
                c.setAttribute('aria-pressed', String(c === chip)));
            renderReport();
        });
    });

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

    $('#form-quick-add').addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = $('#in-quick-add');
        const title = input.value.trim();
        if (!title) { input.focus(); return; }
        if (!state.activeProfileId) return;
        const btn = $('#btn-quick-add');
        btn.disabled = true;
        const ok = await quickAddTask(title);
        btn.disabled = false;
        if (ok) { input.value = ''; $('#modal-add').close(); }
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
        // The app's defaults (TimePeriod.createDefaultPeriods).
        { ...tp('tp-1', 'Morning', '#FFCC00', 6, 12, 0), icon: 'sunrise.fill' },
        { ...tp('tp-2', 'Afternoon', '#34C759', 12, 18, 1), icon: 'sun.max.fill' },
        { ...tp('tp-3', 'Evening', '#007AFF', 18, 24, 2), icon: 'moon.stars.fill' },
    ];
    const everyDay = [1, 2, 3, 4, 5, 6, 7];

    /* Eight weeks of history, not one.
     *
     * The demo used to carry seven days, which meant the statistics
     * screen — the whole point of which is "is this getting better" —
     * opened on a seven-point line with no rolling average, no
     * period-on-period change, and a clamp note explaining why. Long
     * enough to show a trend now, and deterministic, so the preview
     * looks the same for everyone who opens it. */
    const SPAN = 56;
    const weekdayOf = (n) => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - n);
        return d.getUTCDay(); // 0 = Sunday
    };
    const history = (hour, keep) => {
        const out = [];
        for (let n = SPAN; n >= 0; n -= 1) if (keep(n, weekdayOf(n))) out.push(daysAgo(n, hour));
        return out;
    };
    const isWeekend = (w) => w === 0 || w === 6;

    const tasks = [
        // Nearly perfect: the habit that stuck.
        { id: 't-1', profile_id: profileId, title: 'Brush teeth', icon: '🪥', points: 10, time_period_id: 'tp-1', recurrence_days: everyDay, sort_order: 0, completion_history: history(8, (n) => n % 11 !== 5) },
        { id: 't-7', profile_id: profileId, title: 'Get dressed', icon: '👕', points: 5, time_period_id: 'tp-1', recurrence_days: everyDay, sort_order: 1, completion_history: history(8, (n) => n % 6 !== 3) },
        // Was patchy, has taken hold in the last three weeks — not yet today.
        { id: 't-2', profile_id: profileId, title: 'Make the bed', icon: '🛏️', points: 5, time_period_id: 'tp-1', recurrence_days: everyDay, sort_order: 2, completion_history: history(8, (n) => n !== 0 && (n <= 21 ? n % 2 === 0 : n % 4 === 0)) },
        { id: 't-8', profile_id: profileId, title: 'Eat breakfast', icon: '🥣', points: 5, time_period_id: 'tp-1', recurrence_days: everyDay, sort_order: 3, completion_history: history(8, (n) => n !== 0 && n % 5 !== 2) },
        // Weekdays only, and the one that slips.
        { id: 't-3', profile_id: profileId, title: 'Homework', icon: '📚', points: 20, time_period_id: 'tp-2', recurrence_days: [2, 3, 4, 5, 6], sort_order: 2, completion_history: history(16, (n, w) => !isWeekend(w) && (n <= 14 ? n % 3 !== 0 : n % 2 === 0)) },
        { id: 't-4', profile_id: profileId, title: 'Read a book', icon: '📖', points: 15, time_period_id: 'tp-3', recurrence_days: everyDay, sort_order: 3, completion_history: history(20, (n) => n !== 0 && n % 3 !== 1) },
        // Easy at the weekend, forgotten mid-week.
        { id: 't-5', profile_id: profileId, title: 'Feed the cat', icon: '🐱', points: 10, time_period_id: null, recurrence_days: everyDay, sort_order: 4, completion_history: history(17, (n, w) => isWeekend(w) || n % 4 !== 2) },
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
        // Something to save towards, so the balance card has a next goal.
        { id: 'r-4', profile_id: profileId, title: 'Day at the zoo', icon: '🦁', cost: 2500, sort_order: 3 },
    ];
    /* Enough spending to keep the balance in a range a family would
       recognise — eight weeks of earning with one redemption would show
       a four-figure pile of unspent points, which is not what the app
       is for. */
    const redemptions = [
        { id: 'rd-1', profile_id: profileId, reward_title: 'Ice-cream trip', points_spent: 60, redeemed_at: daysAgo(3) },
        { id: 'rd-2', profile_id: profileId, reward_title: 'Movie night', points_spent: 100, redeemed_at: daysAgo(11) },
        { id: 'rd-3', profile_id: profileId, reward_title: '30 min extra screen time', points_spent: 40, redeemed_at: daysAgo(19) },
        { id: 'rd-4', profile_id: profileId, reward_title: 'Movie night', points_spent: 100, redeemed_at: daysAgo(26) },
        { id: 'rd-5', profile_id: profileId, reward_title: 'Ice-cream trip', points_spent: 60, redeemed_at: daysAgo(38) },
        { id: 'rd-6', profile_id: profileId, reward_title: 'Movie night', points_spent: 100, redeemed_at: daysAgo(47) },
    ];
    const bonus = [
        { id: 'b-1', profile_id: profileId, amount: 20, reason: 'Helped with the groceries', date: daysAgo(1) },
        { id: 'b-2', profile_id: profileId, amount: 15, reason: 'Tidied up without being asked', date: daysAgo(9) },
        { id: 'b-3', profile_id: profileId, amount: 25, reason: 'Looked after her brother', date: daysAgo(23) },
    ];
    return { timePeriods: periods, tasks, subtasks, rewards, redemptions, bonus };
}

async function enterDemo() {
    showView('view-app');
    $('#user-email').textContent = 'Sample data';
    wireManagement();
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
