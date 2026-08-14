/* Vigdís web dashboard — talks to the same Supabase backend as the iOS app.
 * The publishable key below is client-safe: every table is protected by
 * row-level security, so a signed-in user can only reach their own profiles. */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://vfdjirmowbjdmieeyjkl.supabase.co';
const SUPABASE_KEY = 'sb_publishable_XxI8jNl0ERoIlLLKdS93_g_cuNyvLy5';
const IMAGE_BUCKET = 'vigdis-images';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ?demo=1 renders the dashboard with sample data and no server writes —
 * useful for previewing the design before signing in. */
const DEMO = new URLSearchParams(location.search).has('demo');

/* Email/password is currently disabled in this Supabase project
 * (external_email_enabled = false) — flip this if it's ever turned on. */
const EMAIL_AUTH_ENABLED = false;

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

function isScheduledToday(task) {
    const rec = task.recurrence_days;
    if (Array.isArray(rec) && rec.length > 0) return rec.includes(appWeekday());
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

async function signInWithProvider(provider) {
    $('#auth-error').textContent = '';
    const { error } = await sb.auth.signInWithOAuth({
        provider,
        options: { redirectTo: authRedirectUrl() },
    });
    if (error) $('#auth-error').textContent = error.message;
}

function surfaceOAuthError() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const desc = params.get('error_description');
    if (desc) {
        $('#auth-error').textContent = desc.replace(/\+/g, ' ');
        history.replaceState(null, '', location.pathname);
    }
}

function bindAuthUI() {
    $('#btn-apple').addEventListener('click', () => signInWithProvider('apple'));
    $('#btn-google').addEventListener('click', () => signInWithProvider('google'));

    if (!EMAIL_AUTH_ENABLED) {
        $('#form-email').hidden = true;
        $('#auth-or-divider').hidden = true;
        $('#note-forgot').hidden = true;
    }

    $('#form-email').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = $('#in-email').value.trim();
        const password = $('#in-password').value;
        const errEl = $('#auth-error');
        errEl.textContent = '';
        if (!email || !password) { errEl.textContent = 'Enter your email address and password.'; return; }

        const btn = $('#btn-signin');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Signing in…';
        const { error } = await sb.auth.signInWithPassword({ email, password });
        btn.disabled = false;
        btn.textContent = 'Sign in';
        if (error) {
            errEl.textContent = error.message === 'Invalid login credentials'
                ? 'That email and password don’t match an account. Check them, or use Apple/Google if that’s how you signed up.'
                : error.message;
        }
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

    state.data = {
        timePeriods: tp.data || [],
        tasks: tasks.data || [],
        subtasks: subtasks.data || [],
        rewards: rewards.data || [],
        redemptions: redemptions.data || [],
        bonus: bonus.data || [],
    };
}

/* Canonical balance — the same formula the server uses in redeem_reward. */
function pointsBalance() {
    const earned = state.data.tasks.reduce(
        (sum, t) => sum + (t.points || 0) * (t.completion_history?.length || 0), 0);
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
    $('#greeting-date').textContent = fmtDate(new Date());
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

    const scheduled = state.data.tasks.filter(isScheduledToday);
    const doneToday = scheduled.filter((t) => isCompletedOn(t, todayKey())).length;

    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
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
    const done = isCompletedOn(task, todayKey());
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
    const visible = state.data.tasks.filter((t) => state.filter === 'all' || isScheduledToday(t));

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
    const wasDone = isCompletedOn(task, todayKey());
    const previous = task.completion_history || [];

    // Optimistic: flip locally first, roll back if the server disagrees.
    const now = new Date().toISOString();
    task.completion_history = wasDone
        ? previous.filter((ts) => dayKey(ts) !== todayKey())
        : [...previous, now];
    renderStats();
    renderTasks();
    renderRewards();
    if (!wasDone) $('#stat-balance')?.classList.add('balance-pulse');
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
    };
    if (DEMO) {
        state.data.tasks.push({ ...row, completion_history: [] });
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

function openTaskModal(taskId) {
    const task = state.data.tasks.find((t) => t.id === taskId);
    if (!task) return;
    state.editingTaskId = taskId;
    $('#task-title').value = task.title || '';
    $('#task-points').value = task.points ?? 0;
    $('#task-icon').value = /^[a-z0-9.]+$/i.test(task.icon || '') ? '' : (task.icon || '');
    $('#task-due').value = task.due_date ? dayKey(task.due_date) : '';
    $('#task-notes').value = task.notes || '';
    $('#modal-task').showModal();
}

async function saveTaskEdits() {
    const task = state.data.tasks.find((t) => t.id === state.editingTaskId);
    if (!task) return;
    const patch = {
        title: $('#task-title').value.trim() || task.title,
        points: Math.max(0, parseInt($('#task-points').value, 10) || 0),
        notes: $('#task-notes').value.trim() || null,
        due_date: $('#task-due').value ? new Date($('#task-due').value + 'T12:00:00').toISOString() : null,
    };
    const icon = $('#task-icon').value.trim();
    if (icon) patch.icon = icon;

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
    state.activeProfileId = profileId;
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
    state.profiles = await loadProfiles();

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

function bindAppUI() {
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
