/* Vigdís web dashboard — setup and management.
 *
 * The dashboard began as a viewer: it could complete a task, redeem a
 * reward and export a CSV, but everything that *creates* the day —
 * profiles, rewards, time periods, subtask steps — was app-only. This
 * module is the setup half, and it is the half a keyboard is actually
 * better at than a phone.
 *
 * Kept out of dashboard.js rather than appended to it. That file is
 * already 1,500 lines with no build step and no tests; tripling it
 * would make the whole thing unreadable. Dependencies arrive through
 * `initManagement(ctx)` rather than by importing dashboard.js back,
 * which would create a module cycle whose evaluation order is exactly
 * the kind of thing that breaks silently in production.
 *
 * Everything here writes through PostgREST directly. That is allowed:
 * every table below carries insert/update/delete RLS policies keyed to
 * profile membership ("Writers can create time periods" and friends),
 * so the server is the thing enforcing access, not this file. The two
 * exceptions are completion and redemption, which go through the same
 * `set_*_completion` / `redeem_reward` functions the app uses so that
 * points and streaks stay consistent across both clients.
 */

/* Filled in by initManagement. Module-level rather than threaded
   through every function — this is a singleton page, and the
   alternative is an extra parameter on forty call sites. */
let sb, state, $, esc, toast, refresh, toggleTask;

/* enterApp() runs on every auth transition, not just the first — the
   password-recovery form calls it directly, and onAuthStateChange can
   fire again on token refresh. Binding twice would attach a second
   submit handler to each form, so one "Save" would insert two rows.
   Bind once; refresh the injected context every time in case the
   session object behind it changed. */
let initialised = false;

export function initManagement(ctx) {
    ({ sb, state, $, esc, toast, refresh, toggleTask } = ctx);
    if (initialised) return;
    initialised = true;
    bindTimePeriodUI();
    bindRewardUI();
    bindStepUI();
    bindProfileUI();
    bindBonusUI();
    bindRecurrenceUI();
    bindSharingUI();
    bindDoModeUI();
}

/* ── Entitlements ──────────────────────────────────────
 *
 * The app caps how many profiles a free account may own, and that cap
 * is enforced client-side only — `can_create_owned_profile()` exists
 * in the schema but no RLS policy references it. So the server will
 * happily accept a profile insert that the app would have refused, and
 * a web client that skipped the check would become the easy way around
 * the app's limit. This is why the gate lives here rather than being
 * left to the database.
 *
 * `active_profile_limit_for_user` is the same function the app reads,
 * so the two clients agree on the number rather than each keeping
 * their own copy of the tier table.
 */

const entitlement = {
    tier: null,
    profileLimit: null,
    loaded: false,
};

export async function loadEntitlement() {
    const userId = state.session?.user?.id;
    if (!userId) return entitlement;

    const [tierRes, limitRes] = await Promise.all([
        sb.from('user_entitlements')
            .select('tier, is_active, expires_at')
            .eq('user_id', userId)
            .eq('is_active', true)
            .maybeSingle(),
        sb.rpc('active_profile_limit_for_user', { target_user_id: userId }),
    ]);

    entitlement.tier = tierRes.data?.tier ?? 'free';
    /* A null limit means "no cap" in the app's model. Treat an errored
       lookup as unlimited rather than zero: a failed read should never
       be the thing that stops a paying customer adding a profile. The
       server still refuses anything RLS disallows. */
    entitlement.profileLimit = limitRes.error ? null : limitRes.data;
    entitlement.loaded = true;
    return entitlement;
}

export function currentEntitlement() {
    return entitlement;
}

/** Profiles this user owns, which is what the cap counts. Profiles
 *  shared *to* them belong to someone else's allowance. */
function ownedProfileCount() {
    const userId = state.session?.user?.id;
    return state.profiles.filter((p) => p.owner_user_id === userId).length;
}

export function canCreateProfile() {
    if (!entitlement.loaded) return { allowed: true };
    const limit = entitlement.profileLimit;
    if (limit == null) return { allowed: true };
    if (ownedProfileCount() < limit) return { allowed: true };
    return {
        allowed: false,
        reason: limit === 1
            ? 'Your plan includes one profile. Upgrade in the app to add another.'
            : `Your plan includes ${limit} profiles. Upgrade in the app to add more.`,
    };
}


/* ── Why you cannot delete from here ───────────────────
 *
 * A delete from the web sets `deleted_at`, which is exactly what the
 * app's own delete does server-side. The difference is what happens
 * afterwards: `pull_changes` filters `deleted_at is null` on all ten
 * tables, so a tombstone is never returned to a client. Every
 * `SyncableEntity.mergeInto` has a working `if deletedAt != nil {
 * delete local }` branch — it simply never receives a row to fire it.
 *
 * Deleting in the app looks like it works because the app removes its
 * own local copy first and pushes the tombstone afterwards. The
 * deleting device never needs to be told. A second device, or the
 * website, does — and never is.
 *
 * So a Remove button here would set `deleted_at` while the app carried
 * on showing the row: one account in two states, and the row gone for
 * good on the next fresh sign-in. An honest "do this in the app" beats
 * a button that quietly diverges the data.
 *
 * Every delete path below is written and works. Flip this to true the
 * moment `pull_changes` returns tombstones and they all come back —
 * that is a one-line change to the function's WHERE clauses.
 */
const DELETE_PROPAGATES_TO_APP = false;

/** Hides a Remove button and explains why, rather than leaving a
 *  control that appears to work. */
function applyDeleteGate(buttonSelector, noteSelector, what) {
    const btn = $(buttonSelector);
    const note = $(noteSelector);
    if (DELETE_PROPAGATES_TO_APP) {
        if (note) note.textContent = '';
        return;
    }
    if (btn) btn.hidden = true;
    if (note) {
        note.textContent = `To remove ${what}, use the app — deletions made here wouldn’t reach it.`;
    }
}

/* ── Shared helpers ────────────────────────────────────── */

const activeProfileId = () => state.activeProfileId;

/** Next sort_order for a list, so new rows land at the end rather
 *  than colliding on 0 and sorting arbitrarily. */
function nextSortOrder(rows) {
    return rows.reduce((max, r) => Math.max(max, r.sort_order ?? 0), -1) + 1;
}

/* `updated_at` is deliberately never set from here. Every table this
   module writes carries a `<table>_set_updated_at` BEFORE UPDATE
   trigger (installed in 0001_baseline) that stamps now() server-side,
   and inserts get it from the column default. Setting it client-side
   would be dead weight at best and, with a skewed device clock, a
   value the app's sync would then reason about incorrectly. */

async function write(promise, okMessage) {
    const { error } = await promise;
    if (error) { toast(`Couldn’t save: ${error.message}`); return false; }
    if (okMessage) toast(okMessage);
    await refresh();
    return true;
}

/* ── Time periods ──────────────────────────────────────
 *
 * The backbone of the day: every task belongs to one, and the app
 * groups the whole task list by them. The dashboard could already read
 * them (the task modal's period picker) but not change them, so a
 * parent who wanted "Homework" to start an hour later had to reach for
 * the phone.
 *
 * start_hour / end_hour are whole hours, 0–24 inclusive, matching the
 * table's check constraint. 24 is meaningful: it's how a period says
 * "until midnight".
 */

/* The exact SF Symbol names the app offers in its own period editor
   (TimePeriodSettingsView.availableIcons). This has to match: the app
   renders the column with `Image(systemName: period.icon)`, so a value
   outside SF Symbols draws nothing at all.
   
   The first version of this list was invented for the web — 'sun',
   'moon', 'bed', 'star'. Every one of those is either not an SF Symbol
   or not one the app offers, so editing a period from the website
   blanked its icon in the app. Emoji here are labels for the web only;
   the value written is always the symbol name. */
const PERIOD_ICONS = [
    ['sunrise.fill', '🌅 Sunrise'],
    ['sun.max.fill', '☀️ Midday'],
    ['sunset.fill', '🌇 Sunset'],
    ['moon.stars.fill', '🌙 Night'],
    ['cup.and.saucer.fill', '☕ Mealtime'],
    ['briefcase.fill', '💼 Work'],
    ['house.fill', '🏠 Home'],
    ['figure.walk', '🚶 Activity'],
    ['book.fill', '📚 Homework'],
    ['gamecontroller.fill', '🎮 Play'],
    ['tv.fill', '📺 Screen time'],
    ['bed.double.fill', '🛏️ Bedtime'],
];

const PERIOD_ICON_KEYS = new Set(PERIOD_ICONS.map(([key]) => key));

function fillPeriodIcons() {
    const sel = $('#period-icon');
    if (!sel || sel.options.length) return;
    sel.innerHTML = PERIOD_ICONS
        .map(([key, label]) => `<option value="${key}">${label}</option>`)
        .join('');
}

/* A period may carry an icon this list doesn't have — an older app
   build, a future one, or the empty string the previous web version
   could write. Selecting a value with no matching <option> silently
   leaves the select on its first entry, so saving would swap the icon
   for whatever happened to be at the top. Add the unknown value as its
   own option instead: the user sees what is actually set, and saving
   without touching the field preserves it. */
function selectPeriodIcon(icon) {
    const sel = $('#period-icon');
    if (!sel) return;
    sel.querySelectorAll('[data-preserved]').forEach((o) => o.remove());

    if (!icon) {
        /* No icon at all. Offer it as an explicit choice rather than
           pretending the period has one — the app's own default is
           'clock', but silently writing that would be us deciding. */
        sel.insertAdjacentHTML('afterbegin',
            '<option value="" data-preserved>— none set —</option>');
        sel.value = '';
        return;
    }

    if (!PERIOD_ICON_KEYS.has(icon)) {
        sel.insertAdjacentHTML('afterbegin',
            `<option value="${icon}" data-preserved>${icon} (set in the app)</option>`);
    }
    sel.value = icon;
}

function bindTimePeriodUI() {
    fillPeriodIcons();
    $('#btn-add-period')?.addEventListener('click', () => openPeriodModal(null));
    $('#form-period')?.addEventListener('submit', savePeriod);
    $('#btn-period-cancel')?.addEventListener('click', () => $('#modal-period').close());
    $('#btn-period-delete')?.addEventListener('click', deletePeriod);
}

let editingPeriodId = null;

export function openPeriodModal(period) {
    editingPeriodId = period?.id ?? null;
    $('#modal-period-title').textContent = period ? 'Edit time period' : 'New time period';
    $('#period-name').value = period?.name ?? '';
    selectPeriodIcon(period?.icon ?? '');
    $('#period-color').value = safeHex(period?.color) ?? '#F0918F';
    $('#period-start').value = period?.start_hour ?? 7;
    $('#period-end').value = period?.end_hour ?? 12;
    $('#btn-period-delete').hidden = !period;
    applyDeleteGate('#btn-period-delete', '#period-delete-note', 'a time period');
    $('#period-error').textContent = '';
    $('#modal-period').showModal();
}

/** The colour column is free text, so a row written by an older client
 *  can hold something `<input type="color">` refuses to display. Fall
 *  back rather than letting one bad row blank the picker. */
function safeHex(value) {
    return /^#[0-9a-f]{6}$/i.test(value || '') ? value : null;
}

async function savePeriod(e) {
    e.preventDefault();
    const name = $('#period-name').value.trim();
    const start = Number($('#period-start').value);
    const end = Number($('#period-end').value);
    const errEl = $('#period-error');
    errEl.textContent = '';

    if (!name) { errEl.textContent = 'Give the period a name.'; return; }
    if (!Number.isInteger(start) || !Number.isInteger(end)
        || start < 0 || start > 24 || end < 0 || end > 24) {
        errEl.textContent = 'Hours must be whole numbers between 0 and 24.';
        return;
    }
    /* Equal start and end would make a period that never matches, and
       the app groups tasks by "is now inside this period" — a silent
       empty group is worse than refusing the save. Crossing midnight
       (start > end) is left alone deliberately: the app supports an
       evening period that runs past midnight. */
    if (start === end) {
        errEl.textContent = 'Start and end can’t be the same hour.';
        return;
    }

    const row = {
        name,
        color: $('#period-color').value,
        start_hour: start,
        end_hour: end,
    };

    /* Only send `icon` when there is one to send. The column is NOT
       NULL, and writing '' would leave the app calling
       Image(systemName: "") — a blank where the period's icon used to
       be. Omitting the key leaves whatever is already stored alone. */
    const chosenIcon = $('#period-icon').value;
    if (chosenIcon) row.icon = chosenIcon;

    const ok = editingPeriodId
        ? await write(sb.from('time_periods').update(row).eq('id', editingPeriodId), 'Time period saved.')
        : await write(sb.from('time_periods').insert({
            ...row,
            profile_id: activeProfileId(),
            sort_order: nextSortOrder(state.data.timePeriods),
        }), 'Time period added.');

    if (ok) $('#modal-period').close();
}

async function deletePeriod() {
    if (!editingPeriodId) return;

    /* Tasks reference a period by id. The FK is ON DELETE CASCADE, so a
       hard delete would take the tasks with it — which is emphatically
       not what "remove this period" means to a parent. Soft-delete
       instead (what every other client does), and refuse while tasks
       still point at it so nothing ends up orphaned in a group that no
       longer renders. */
    const attached = state.data.tasks.filter(
        (t) => t.time_period_id === editingPeriodId && !t.deleted_at);
    if (attached.length) {
        $('#period-error').textContent = attached.length === 1
            ? 'One task still uses this period. Move it first.'
            : `${attached.length} tasks still use this period. Move them first.`;
        return;
    }

    const ok = await write(
        sb.from('time_periods')
            .update({ deleted_at: new Date().toISOString() })
            .eq('id', editingPeriodId),
        'Time period removed.');
    if (ok) $('#modal-period').close();
}

export async function movePeriod(periodId, direction) {
    const ordered = [...state.data.timePeriods].sort(
        (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const index = ordered.findIndex((p) => p.id === periodId);
    const swapWith = index + direction;
    if (index < 0 || swapWith < 0 || swapWith >= ordered.length) return;

    /* Swap the two sort_order values rather than renumbering the list.
       Two writes instead of N, and it leaves every other row's value
       untouched so a concurrent edit on the phone doesn't collide. */
    const a = ordered[index];
    const b = ordered[swapWith];
    const { error } = await sb.from('time_periods').upsert([
        { id: a.id, profile_id: a.profile_id, name: a.name, sort_order: b.sort_order ?? 0 },
        { id: b.id, profile_id: b.profile_id, name: b.name, sort_order: a.sort_order ?? 0 },
    ]);
    if (error) { toast(`Couldn’t reorder: ${error.message}`); return; }
    await refresh();
}

export function renderTimePeriods() {
    const host = $('#period-list');
    if (!host) return;
    const ordered = [...state.data.timePeriods].sort(
        (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    if (!ordered.length) {
        host.innerHTML = '<p class="empty">No time periods yet. Add one to group the day.</p>';
        return;
    }

    host.innerHTML = ordered.map((p, i) => {
        const taskCount = state.data.tasks.filter(
            (t) => t.time_period_id === p.id && !t.deleted_at).length;
        return `
        <div class="manage-row">
            <span class="manage-row__dot" style="background:${esc(safeHex(p.color) || '#ccc')}"></span>
            <div class="manage-row__body">
                <div class="manage-row__title">${esc(p.name)}</div>
                <div class="manage-row__meta">${p.start_hour}:00–${p.end_hour}:00 · ${taskCount} task${taskCount === 1 ? '' : 's'}</div>
            </div>
            <button class="reorder-btn" data-period-up="${esc(p.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
            <button class="reorder-btn" data-period-down="${esc(p.id)}" ${i === ordered.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
            <button class="btn-ghost" data-period-edit="${esc(p.id)}">Edit</button>
        </div>`;
    }).join('');

    host.querySelectorAll('[data-period-edit]').forEach((b) =>
        b.addEventListener('click', () => openPeriodModal(
            state.data.timePeriods.find((p) => p.id === b.dataset.periodEdit))));
    host.querySelectorAll('[data-period-up]').forEach((b) =>
        b.addEventListener('click', () => movePeriod(b.dataset.periodUp, -1)));
    host.querySelectorAll('[data-period-down]').forEach((b) =>
        b.addEventListener('click', () => movePeriod(b.dataset.periodDown, 1)));
}

/* ── Rewards ───────────────────────────────────────────
 *
 * The dashboard could already redeem a reward but not create one, which
 * is backwards: redeeming is a ten-second act a child does on the phone,
 * while building a reward store is a sit-down typing job. This is the
 * clearest case in the whole gap list of the web being the better
 * surface.
 */

function bindRewardUI() {
    $('#btn-add-reward')?.addEventListener('click', () => openRewardModal(null));
    $('#form-reward')?.addEventListener('submit', saveReward);
    $('#btn-reward-cancel')?.addEventListener('click', () => $('#modal-reward').close());
    $('#btn-reward-delete')?.addEventListener('click', deleteReward);
}

let editingRewardId = null;

export function openRewardModal(reward) {
    editingRewardId = reward?.id ?? null;
    $('#modal-reward-title').textContent = reward ? 'Edit reward' : 'New reward';
    $('#reward-title').value = reward?.title ?? '';
    $('#reward-icon').value = reward?.icon ?? '🎁';
    $('#reward-cost').value = reward?.cost ?? 20;
    $('#btn-reward-delete').hidden = !reward;
    applyDeleteGate('#btn-reward-delete', '#reward-delete-note', 'a reward');
    $('#reward-error').textContent = '';
    $('#modal-reward').showModal();
}

async function saveReward(e) {
    e.preventDefault();
    const title = $('#reward-title').value.trim();
    const cost = Number($('#reward-cost').value);
    const errEl = $('#reward-error');
    errEl.textContent = '';

    if (!title) { errEl.textContent = 'Give the reward a name.'; return; }
    /* Zero is allowed on purpose — a "free" reward is a legitimate way
       to hand out something without spending a balance. Negative is
       not: redeem_reward subtracts the cost, so a negative one would
       mint points. */
    if (!Number.isInteger(cost) || cost < 0) {
        errEl.textContent = 'Cost must be a whole number, zero or more.';
        return;
    }

    const row = { title, icon: $('#reward-icon').value.trim(), cost };

    const ok = editingRewardId
        ? await write(sb.from('rewards').update(row).eq('id', editingRewardId), 'Reward saved.')
        : await write(sb.from('rewards').insert({
            ...row,
            profile_id: activeProfileId(),
            sort_order: nextSortOrder(state.data.rewards),
        }), 'Reward added.');

    if (ok) $('#modal-reward').close();
}

async function deleteReward() {
    if (!editingRewardId) return;
    /* Soft delete. Past redemptions reference the reward, and the
       activity feed reads its title — a hard delete would blank rows in
       a history the family may well scroll back through. */
    const ok = await write(
        sb.from('rewards')
            .update({ deleted_at: new Date().toISOString() })
            .eq('id', editingRewardId),
        'Reward removed.');
    if (ok) $('#modal-reward').close();
}

export function renderManageRewards() {
    const host = $('#manage-reward-list');
    if (!host) return;
    const ordered = [...state.data.rewards].sort(
        (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    if (!ordered.length) {
        host.innerHTML = '<p class="empty">No rewards yet. Add something worth saving points for.</p>';
        return;
    }

    host.innerHTML = ordered.map((r) => {
        const timesRedeemed = state.data.redemptions.filter((x) => x.reward_id === r.id).length;
        return `
        <div class="manage-row">
            <span class="reward-row__tile" aria-hidden="true">${esc(r.icon || '🎁')}</span>
            <div class="manage-row__body">
                <div class="manage-row__title">${esc(r.title)}</div>
                <div class="manage-row__meta">${r.cost} points${timesRedeemed ? ` · redeemed ${timesRedeemed}×` : ''}</div>
            </div>
            <button class="btn-ghost" data-reward-edit="${esc(r.id)}">Edit</button>
        </div>`;
    }).join('');

    host.querySelectorAll('[data-reward-edit]').forEach((b) =>
        b.addEventListener('click', () => openRewardModal(
            state.data.rewards.find((r) => r.id === b.dataset.rewardEdit))));
}

/** Single entry point for the Setup view, so dashboard.js has one thing
 *  to call rather than tracking which lists this module owns. */
export function renderManagement() {
    renderManageProfiles();
    renderAchievements();
    renderTimerSessions();
    renderSharing();
    renderTimePeriods();
    renderManageRewards();
}

/* ── Steps (subtasks) ──────────────────────────────────
 *
 * Subtasks were loaded and counted ("2/5 steps" in a task row) but
 * otherwise invisible: no way to add one, rename one, reorder them, or
 * tick one off. `set_subtask_completion` has existed server-side the
 * whole time and simply had no caller on the web — SETUP.md claimed
 * otherwise, which is corrected there now.
 *
 * Completion goes through the RPC rather than a direct update because
 * the function is what keeps `completed_on` and the parent task's
 * progress consistent. Structural edits (title, order, existence) are
 * plain table writes, which RLS covers.
 */

/* Which task's steps the modal is currently showing. Set by
   renderTaskSteps, read by the add/reorder handlers, because the
   modal is reused for every task rather than rebuilt per task. */
let stepsTaskId = null;

function bindStepUI() {
    $('#btn-add-step')?.addEventListener('click', addStep);
    /* Enter inside the step box must not submit the surrounding task
       form — the modal's form would close and swallow the step. */
    $('#new-step-title')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addStep(); }
    });
}

export function renderTaskSteps(taskId) {
    stepsTaskId = taskId ?? null;
    const host = $('#task-steps');
    if (!host) return;
    $('#step-error').textContent = '';

    if (!taskId) { host.innerHTML = ''; return; }

    const steps = state.data.subtasks
        .filter((s) => s.task_id === taskId && !s.deleted_at)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    if (!steps.length) {
        host.innerHTML = '<p class="rnote">No steps yet. A task with steps becomes a checklist the child works down.</p>';
        return;
    }

    const deleteNote = DELETE_PROPAGATES_TO_APP
        ? ''
        : '<p class="rnote">Steps can be renamed and reordered here. Removing one has to be done in the app.</p>';

    host.innerHTML = deleteNote + steps.map((st, i) => `
        <div class="manage-row manage-row--step">
            <input type="checkbox" data-step-toggle="${esc(st.id)}" ${st.is_completed ? 'checked' : ''}
                   aria-label="Mark ${esc(st.title)} done">
            <div class="manage-row__body">
                <input class="step-title" type="text" value="${esc(st.title)}" maxlength="120"
                       data-step-title="${esc(st.id)}" aria-label="Step name">
            </div>
            <button class="reorder-btn" data-step-up="${esc(st.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
            <button class="reorder-btn" data-step-down="${esc(st.id)}" ${i === steps.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
            ${DELETE_PROPAGATES_TO_APP
                ? `<button class="btn-danger-quiet" data-step-delete="${esc(st.id)}" aria-label="Remove step">×</button>`
                : ''}
        </div>`).join('');

    host.querySelectorAll('[data-step-toggle]').forEach((el) =>
        el.addEventListener('change', () => toggleStep(el.dataset.stepToggle, el.checked)));
    /* Rename on blur, not on every keystroke: one write per edit
       instead of one per character. */
    host.querySelectorAll('[data-step-title]').forEach((el) =>
        el.addEventListener('blur', () => renameStep(el.dataset.stepTitle, el.value)));
    host.querySelectorAll('[data-step-up]').forEach((el) =>
        el.addEventListener('click', () => moveStep(el.dataset.stepUp, -1)));
    host.querySelectorAll('[data-step-down]').forEach((el) =>
        el.addEventListener('click', () => moveStep(el.dataset.stepDown, 1)));
    host.querySelectorAll('[data-step-delete]').forEach((el) =>
        el.addEventListener('click', () => deleteStep(el.dataset.stepDelete)));
}

async function addStep() {
    const input = $('#new-step-title');
    const title = input.value.trim();
    const errEl = $('#step-error');
    errEl.textContent = '';
    if (!stepsTaskId) return;
    if (!title) { errEl.textContent = 'Type the step first.'; input.focus(); return; }

    const siblings = state.data.subtasks.filter((s) => s.task_id === stepsTaskId);
    const { error } = await sb.from('subtasks').insert({
        profile_id: activeProfileId(),
        task_id: stepsTaskId,
        title,
        sort_order: nextSortOrder(siblings),
    });
    if (error) { errEl.textContent = error.message; return; }

    input.value = '';
    await refresh();
    renderTaskSteps(stepsTaskId);
    input.focus();
}

async function toggleStep(subtaskId, isCompleted) {
    const { error } = await sb.rpc('set_subtask_completion', {
        target_profile_id: activeProfileId(),
        target_subtask_id: subtaskId,
        is_completed: isCompleted,
    });
    if (error) { toast(`Couldn’t update the step: ${error.message}`); }
    await refresh();
    renderTaskSteps(stepsTaskId);
}

async function renameStep(subtaskId, rawTitle) {
    const title = rawTitle.trim();
    const existing = state.data.subtasks.find((s) => s.id === subtaskId);
    /* Blur fires even when nothing changed, and an empty box is a
       mis-edit rather than a request to delete — put the old name back
       instead of writing a nameless step. */
    if (!existing || title === existing.title) return;
    if (!title) { renderTaskSteps(stepsTaskId); return; }

    const { error } = await sb.from('subtasks').update({ title }).eq('id', subtaskId);
    if (error) { toast(`Couldn’t rename the step: ${error.message}`); }
    await refresh();
}

async function moveStep(subtaskId, direction) {
    const ordered = state.data.subtasks
        .filter((s) => s.task_id === stepsTaskId && !s.deleted_at)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const index = ordered.findIndex((s) => s.id === subtaskId);
    const swapWith = index + direction;
    if (index < 0 || swapWith < 0 || swapWith >= ordered.length) return;

    const a = ordered[index];
    const b = ordered[swapWith];
    const [r1, r2] = await Promise.all([
        sb.from('subtasks').update({ sort_order: b.sort_order ?? 0 }).eq('id', a.id),
        sb.from('subtasks').update({ sort_order: a.sort_order ?? 0 }).eq('id', b.id),
    ]);
    const error = r1.error || r2.error;
    if (error) { toast(`Couldn’t reorder: ${error.message}`); return; }
    await refresh();
    renderTaskSteps(stepsTaskId);
}

async function deleteStep(subtaskId) {
    const { error } = await sb.from('subtasks')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', subtaskId);
    if (error) { toast(`Couldn’t remove the step: ${error.message}`); return; }
    await refresh();
    renderTaskSteps(stepsTaskId);
}

/* ── Profiles ──────────────────────────────────────────
 *
 * The dashboard's profile strip was a read-only switcher: a parent
 * adding a second child had to pick up the phone. Creating one here is
 * gated by `canCreateProfile()` rather than left to the server, because
 * the profile cap is enforced client-side only — see the entitlement
 * section for why that makes the web a bypass if it doesn't check.
 *
 * Photo and cover are deliberately absent. The app writes them to
 * `profiles/<id>/avatar.jpg`, but the storage RLS resolver
 * (`cloud_image_profile_id`) only recognises `profile-avatars/` and
 * `profile-covers/` as prefixes and returns null for anything under
 * `profiles/`; `can_write_profile(null)` is false, so those uploads are
 * refused. Adding a web uploader would mean either reproducing a broken
 * path or inventing a working one the app cannot read. Both are worse
 * than leaving it out until the resolver is fixed.
 */

const LIST_STYLES = [
    ['standard', 'Standard'],
    ['traditional', 'Traditional'],
];

/* The rest of the per-profile preferences that actually sync. Theme,
   appearance and the completion chime moved out of device @AppStorage
   and into columns in migration 0007 precisely so they follow the
   child rather than the handset — which is what makes them editable
   from here at all. Anything still device-local (PIN and child mode,
   calm mode) is deliberately absent: a web toggle writing to a column
   no client reads would look like it worked and change nothing. */
/* All 23, generated against the app's AppTheme enum. An earlier
   hand-written list had ten, so a profile on Tangerine rendered
   correctly but could not be re-selected — and, because a <select>
   silently falls back to its first option, saving that profile would
   have quietly reset it to Coral. Same failure the period icons had. */
const THEMES = [
    ['coral', 'Coral'],
    ['ocean', 'Ocean'],
    ['forest', 'Forest'],
    ['lavender', 'Lavender'],
    ['sunset', 'Sunset'],
    ['midnight', 'Midnight'],
    ['rose', 'Rose'],
    ['mint', 'Mint'],
    ['berry', 'Berry'],
    ['slate', 'Slate'],
    ['sunflower', 'Sunflower'],
    ['bubblegum', 'Bubblegum'],
    ['sky', 'Sky'],
    ['matcha', 'Matcha'],
    ['ruby', 'Ruby'],
    ['tangerine', 'Tangerine'],
    ['lagoon', 'Lagoon'],
    ['lilac', 'Lilac'],
    ['moss', 'Moss'],
    ['cocoa', 'Cocoa'],
    ['ice', 'Ice'],
    ['grape', 'Grape'],
    ['apricot', 'Apricot'],
];

const APPEARANCES = [
    ['light', 'Light'], ['dark', 'Dark'], ['system', 'Match device'],
];

const CHIMES = [
    ['felt', 'Felt'], ['sunrise', 'Sunrise'], ['bounce', 'Bounce'],
    ['pluck', 'Pluck'], ['smile', 'Smile'], ['chime', 'Chime'],
    ['bloom', 'Bloom'], ['vigdis', 'Vigdís'], ['system', 'System'],
];

const PROFILE_LANGUAGES = [
    ['en', 'English'],
    ['is', 'Íslenska'],
];

function bindProfileUI() {
    $('#btn-add-profile')?.addEventListener('click', () => openProfileModal(null));
    $('#form-profile')?.addEventListener('submit', saveProfile);
    $('#btn-profile-cancel')?.addEventListener('click', () => $('#modal-profile').close());
    $('#btn-profile-delete')?.addEventListener('click', deleteProfile);
    fillSelect($('#profile-language'), PROFILE_LANGUAGES);
    fillSelect($('#profile-list-style'), LIST_STYLES);
    fillSelect($('#profile-theme'), THEMES);
    fillSelect($('#profile-appearance'), APPEARANCES);
    fillSelect($('#profile-chime'), CHIMES);
}

/** Selects `value`, adding it as an option first if the list does not
 *  contain it. Without this a <select> silently lands on its first
 *  entry and the next save writes that instead — how a profile on a
 *  theme the web had not heard of would get reset to Coral. */
function selectWithFallback(sel, value, fallback) {
    if (!sel) return;
    sel.querySelectorAll('[data-preserved]').forEach((o) => o.remove());
    const wanted = value || fallback;
    const known = [...sel.options].some((o) => o.value === wanted);
    if (!known) {
        sel.insertAdjacentHTML('afterbegin',
            `<option value="${wanted}" data-preserved>${wanted} (set in the app)</option>`);
    }
    sel.value = wanted;
}

function fillSelect(sel, pairs) {
    if (!sel || sel.options.length) return;
    sel.innerHTML = pairs.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
}

let editingProfileId = null;

export function openProfileModal(profile) {
    if (!profile) {
        const gate = canCreateProfile();
        if (!gate.allowed) { toast(gate.reason, { duration: 7000 }); return; }
    }

    editingProfileId = profile?.id ?? null;
    $('#modal-profile-title').textContent = profile ? 'Edit profile' : 'New profile';
    $('#profile-name').value = profile?.name ?? '';
    selectWithFallback($('#profile-language'), profile?.language, 'en');
    selectWithFallback($('#profile-list-style'), profile?.task_list_style_raw, 'standard');
    $('#profile-show-score').checked = profile?.show_score ?? true;
    $('#profile-show-streaks').checked = profile?.show_streaks ?? true;
    $('#profile-show-confetti').checked = profile?.show_confetti ?? true;
    selectWithFallback($('#profile-theme'), profile?.selected_theme_raw, 'coral');
    selectWithFallback($('#profile-appearance'), profile?.appearance_mode_raw, 'light');
    selectWithFallback($('#profile-chime'), profile?.completion_chime_raw, 'felt');
    $('#profile-sound').checked = profile?.completion_sound_enabled ?? false;

    /* Only an owner may delete, and deleting the profile you are
       currently looking at needs somewhere to land afterwards — so the
       button is hidden when this is the last one. */
    const isOwner = profile && profile.owner_user_id === state.session?.user?.id;
    const delBtn = $('#btn-profile-delete');
    delBtn.hidden = !isOwner || state.profiles.length < 2;
    /* Reset the two-step arming, or reopening the modal after backing
       out of a delete would show a button already primed to fire. */
    delBtn.dataset.armed = '';
    delBtn.textContent = 'Remove profile';
    applyDeleteGate('#btn-profile-delete', '#profile-delete-note', 'a profile');

    $('#profile-error').textContent = '';
    $('#modal-profile').showModal();
}

async function saveProfile(e) {
    e.preventDefault();
    const name = $('#profile-name').value.trim();
    const errEl = $('#profile-error');
    errEl.textContent = '';
    if (!name) { errEl.textContent = 'Give the profile a name.'; return; }

    const row = {
        name,
        language: $('#profile-language').value,
        task_list_style_raw: $('#profile-list-style').value,
        show_score: $('#profile-show-score').checked,
        show_streaks: $('#profile-show-streaks').checked,
        show_confetti: $('#profile-show-confetti').checked,
        selected_theme_raw: $('#profile-theme').value,
        appearance_mode_raw: $('#profile-appearance').value,
        completion_chime_raw: $('#profile-chime').value,
        completion_sound_enabled: $('#profile-sound').checked,
    };

    if (editingProfileId) {
        const { error } = await sb.from('profiles').update(row).eq('id', editingProfileId);
        if (error) { errEl.textContent = error.message; return; }
        toast('Profile saved.');
        /* Recolour straight away if this is the profile on screen —
           picking a theme and not seeing it is the kind of lag that
           makes a settings screen feel broken. */
        if (editingProfileId === state.activeProfileId) {
            applyProfileTheme({ ...row, id: editingProfileId });
        }
    } else {
        /* owner_user_id must be this user: the "Users can create owned
           profiles" policy checks it, and the add_owner_membership
           trigger uses it to write the membership row that everything
           else keys off. */
        const { data, error } = await sb.from('profiles').insert({
            ...row,
            owner_user_id: state.session?.user?.id,
        }).select().single();
        if (error) { errEl.textContent = error.message; return; }
        toast(`${name} added.`);
        state.profiles = [...state.profiles, data];
    }

    $('#modal-profile').close();
    await reloadProfilesAndRender();
}

async function deleteProfile() {
    if (!editingProfileId) return;
    const profile = state.profiles.find((p) => p.id === editingProfileId);
    const errEl = $('#profile-error');

    /* Two-step rather than a confirm() dialog: a browser confirm blocks
       the page and reads as a bug in an app that otherwise never uses
       one. The button re-labels itself and only deletes on the second
       press. */
    const btn = $('#btn-profile-delete');
    if (btn.dataset.armed !== '1') {
        btn.dataset.armed = '1';
        btn.textContent = `Really remove ${profile?.name ?? 'this profile'}?`;
        setTimeout(() => {
            if (!btn) return;
            btn.dataset.armed = '';
            btn.textContent = 'Remove profile';
        }, 5000);
        return;
    }

    btn.dataset.armed = '';
    btn.textContent = 'Remove profile';

    /* Soft delete, matching every other client. The row's tasks,
       rewards and history stay intact, which is what makes this
       recoverable from the app if it was a mistake. */
    const { error } = await sb.from('profiles')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', editingProfileId);
    if (error) { errEl.textContent = error.message; return; }

    toast('Profile removed.');
    $('#modal-profile').close();

    /* If the removed profile was the one on screen, move to another
       before re-rendering — otherwise every panel renders against a
       profile that no longer loads. */
    if (state.activeProfileId === editingProfileId) {
        state.activeProfileId = null;
        localStorage.removeItem('vigdis-web-profile');
    }
    await reloadProfilesAndRender();
}

/* Profiles live outside the per-profile data bundle that `refresh`
   reloads, so a change to the profile list needs its own round trip. */
let reloadProfilesAndRender = async () => { await refresh(); };

export function setProfileReloader(fn) {
    reloadProfilesAndRender = fn;
}

export function renderManageProfiles() {
    const host = $('#profile-manage-list');
    if (!host) return;
    const userId = state.session?.user?.id;

    host.innerHTML = state.profiles.map((p) => {
        const owned = p.owner_user_id === userId;
        return `
        <div class="manage-row">
            <span class="reward-row__tile" aria-hidden="true">${esc((p.name || '?').trim().charAt(0).toUpperCase())}</span>
            <div class="manage-row__body">
                <div class="manage-row__title">${esc(p.name)}</div>
                <div class="manage-row__meta">${owned ? 'Yours' : 'Shared with you'} · ${p.language === 'is' ? 'Íslenska' : 'English'}</div>
            </div>
            <button class="btn-ghost" data-profile-edit="${esc(p.id)}">Edit</button>
        </div>`;
    }).join('') || '<p class="empty">No profiles yet.</p>';

    host.querySelectorAll('[data-profile-edit]').forEach((b) =>
        b.addEventListener('click', () => openProfileModal(
            state.profiles.find((p) => p.id === b.dataset.profileEdit))));

    /* Show the cap rather than only enforcing it — a disabled button
       with no explanation is the worst version of a limit. */
    const gate = canCreateProfile();
    const addBtn = $('#btn-add-profile');
    if (addBtn) {
        addBtn.disabled = !gate.allowed;
        addBtn.title = gate.allowed ? '' : gate.reason;
    }
    const note = $('#profile-limit-note');
    if (note) note.textContent = gate.allowed ? '' : gate.reason;
}

/* ── Bonus points ──────────────────────────────────────
 *
 * The app calls this Instant Praise: points handed out for something
 * that was never on the list. The dashboard already counted them into
 * the balance but had no way to award any, which made the web read the
 * ledger without being able to write to it.
 *
 * A plain insert rather than `spend_points`: that function subtracts
 * against a balance and is the redemption path. Awarding is additive
 * and has no balance to check.
 */

function bindBonusUI() {
    $('#btn-award-bonus')?.addEventListener('click', openBonusModal);
    $('#form-bonus')?.addEventListener('submit', saveBonus);
    $('#btn-bonus-cancel')?.addEventListener('click', () => $('#modal-bonus').close());
}

function openBonusModal() {
    $('#bonus-amount').value = 5;
    $('#bonus-reason').value = '';
    $('#bonus-error').textContent = '';
    $('#modal-bonus').showModal();
}

async function saveBonus(e) {
    e.preventDefault();
    const amount = Number($('#bonus-amount').value);
    const reason = $('#bonus-reason').value.trim();
    const errEl = $('#bonus-error');
    errEl.textContent = '';

    /* Negative is allowed on purpose — the app lets a parent correct a
       mistaken award, and refusing it here would mean the only way to
       undo one is on the phone. Zero is not: it is a no-op that would
       clutter the activity feed. */
    if (!Number.isInteger(amount) || amount === 0) {
        errEl.textContent = 'Enter a whole number of points, not zero.';
        return;
    }
    if (!reason) { errEl.textContent = 'Say what the points are for.'; return; }

    const ok = await write(sb.from('bonus_points').insert({
        profile_id: activeProfileId(),
        amount,
        reason,
        date: new Date().toISOString(),
    }), amount > 0 ? `${amount} points awarded.` : `${Math.abs(amount)} points removed.`);

    if (ok) $('#modal-bonus').close();
}

/* ── Recurrence ────────────────────────────────────────
 *
 * `recurrence_days` holds Apple Calendar weekdays: 1 = Sunday through
 * 7 = Saturday. dashboard.js already read it to decide whether a task
 * shows today; this makes it writable, which is what turns "add a
 * task" on the web into "set up the week".
 *
 * `recurrence_pattern` is a separate column constrained to
 * daily/weekly/monthly. The app treats an explicit day list as the
 * source of truth, so this writes the days and sets the pattern to
 * 'weekly' alongside — leaving pattern stale while days change is how
 * the two disagree.
 */

const WEEKDAYS = [
    [1, 'Sun'], [2, 'Mon'], [3, 'Tue'], [4, 'Wed'], [5, 'Thu'], [6, 'Fri'], [7, 'Sat'],
];

function bindRecurrenceUI() {
    const host = $('#task-recurrence');
    if (!host || host.children.length) return;
    host.innerHTML = WEEKDAYS.map(([n, label]) =>
        `<label><input type="checkbox" data-weekday="${n}"> ${label}</label>`).join('')
        + '<button class="btn-ghost" type="button" id="btn-rec-daily">Daily</button>'
        + '<button class="btn-ghost" type="button" id="btn-rec-weekdays">Weekdays</button>'
        + '<button class="btn-ghost" type="button" id="btn-rec-none">None</button>';

    $('#btn-rec-daily')?.addEventListener('click', () => setRecurrence([1, 2, 3, 4, 5, 6, 7]));
    $('#btn-rec-weekdays')?.addEventListener('click', () => setRecurrence([2, 3, 4, 5, 6]));
    $('#btn-rec-none')?.addEventListener('click', () => setRecurrence([]));
}

export function setRecurrence(days) {
    document.querySelectorAll('[data-weekday]').forEach((cb) => {
        cb.checked = days.includes(Number(cb.dataset.weekday));
    });
}

/** Read the checkboxes back. Exported so dashboard.js's saveTaskEdits
 *  can fold the result into its existing patch rather than this module
 *  writing the task row behind its back. */
export function readRecurrence() {
    const days = [...document.querySelectorAll('[data-weekday]')]
        .filter((cb) => cb.checked)
        .map((cb) => Number(cb.dataset.weekday))
        .sort((a, b) => a - b);
    return {
        recurrence_days: days,
        /* No days means "not repeating", and the pattern has to go null
           with them or a task with an empty day list still claims to be
           weekly. */
        recurrence_pattern: days.length ? 'weekly' : null,
    };
}

/* ── Achievements + timers (read-only) ─────────────────
 *
 * Both are records of things that already happened, produced by the
 * app. There is nothing sensible to edit here — an achievement the web
 * could hand out would not be an achievement — so the web's job is to
 * show them, which it previously did not do at all.
 */

export async function loadReadOnlyExtras(profileId) {
    const [ach, timers] = await Promise.all([
        sb.from('achievements').select('*')
            .eq('profile_id', profileId).is('deleted_at', null)
            .order('unlocked_at', { ascending: false, nullsFirst: false }),
        sb.from('timer_sessions').select('*')
            .eq('profile_id', profileId).is('deleted_at', null)
            .order('start_time', { ascending: false })
            .limit(20),
    ]);
    state.data.achievements = ach.data || [];
    state.data.timerSessions = timers.data || [];
}

export function renderAchievements() {
    const host = $('#achievement-list');
    if (!host) return;
    const rows = state.data.achievements || [];
    const unlocked = rows.filter((a) => a.is_unlocked);

    if (!rows.length) {
        host.innerHTML = '<p class="empty">No achievements yet. They unlock as the app is used.</p>';
        return;
    }

    host.innerHTML = `<p class="rnote">${unlocked.length} of ${rows.length} unlocked.</p>`
        + rows.map((a) => `
        <div class="manage-row ${a.is_unlocked ? '' : 'is-locked'}">
            <span class="reward-row__tile" aria-hidden="true">${a.is_unlocked ? '🏆' : '🔒'}</span>
            <div class="manage-row__body">
                <div class="manage-row__title">${esc(a.name)}</div>
                <div class="manage-row__meta">${esc(a.achievement_description || '')}${
                    a.target_value ? ` · ${a.current_value ?? 0}/${a.target_value}` : ''}</div>
            </div>
        </div>`).join('');
}

export function renderTimerSessions() {
    const host = $('#timer-list');
    if (!host) return;
    const rows = state.data.timerSessions || [];

    if (!rows.length) {
        host.innerHTML = '<p class="empty">No focus-timer sessions recorded yet.</p>';
        return;
    }

    const titleFor = (taskId) =>
        state.data.tasks.find((t) => t.id === taskId)?.title || 'Removed task';

    host.innerHTML = rows.map((t) => {
        const mins = Math.round((t.duration_seconds || 0) / 60);
        return `
        <div class="manage-row">
            <span class="reward-row__tile" aria-hidden="true">⏱️</span>
            <div class="manage-row__body">
                <div class="manage-row__title">${esc(titleFor(t.task_id))}</div>
                <div class="manage-row__meta">${mins} min · ${new Date(t.start_time).toLocaleDateString()}</div>
            </div>
        </div>`;
    }).join('');
}

/* ── Family sharing ────────────────────────────────────
 *
 * Everything here goes through RPCs rather than touching
 * profile_members / profile_invites directly. Those tables carry the
 * rules that make sharing safe — an owner cannot be revoked, an invite
 * belongs to one email, a role cannot be escalated — and the functions
 * are where those rules live. Writing the rows from here would mean
 * reimplementing all of it in a client anyone can edit.
 *
 * Roles come from the profile_role enum. 'owner' is deliberately not
 * offerable: ownership transfers are not something to do by accident
 * from a web form.
 */

const INVITE_ROLES = [
    ['parent', 'Parent — can do everything except delete the profile'],
    ['editor', 'Editor — can add and edit tasks'],
    ['follow_only', 'Follow only — can watch, not change'],
];

function bindSharingUI() {
    $('#btn-invite')?.addEventListener('click', openInviteModal);
    $('#form-invite')?.addEventListener('submit', sendInvite);
    $('#btn-invite-cancel')?.addEventListener('click', () => $('#modal-invite').close());
    $('#btn-referral-copy')?.addEventListener('click', copyReferralCode);
    fillSelect($('#invite-role'), INVITE_ROLES);
}

function openInviteModal() {
    if (!activeProfileId()) return;
    $('#invite-email').value = '';
    $('#invite-role').value = 'parent';
    $('#invite-error').textContent = '';
    $('#modal-invite').showModal();
}

async function sendInvite(e) {
    e.preventDefault();
    const email = $('#invite-email').value.trim();
    const errEl = $('#invite-error');
    errEl.textContent = '';
    if (!email) { errEl.textContent = 'Enter the email address to invite.'; return; }

    const { error } = await sb.rpc('create_profile_invite', {
        target_profile_id: activeProfileId(),
        invite_email: email,
        invite_role: $('#invite-role').value,
    });
    if (error) { errEl.textContent = error.message; return; }

    toast(`Invite sent to ${email}.`);
    $('#modal-invite').close();
    await refreshShares();
}

let shares = [];

export async function refreshShares() {
    const profileId = activeProfileId();
    if (!profileId) { shares = []; renderSharing(); return; }
    const { data, error } = await sb.rpc('list_profile_shares', { target_profile_id: profileId });
    /* A non-admin gets an error here rather than an empty list, which
       is correct — they simply have no business seeing who else has
       access. Fall back to empty rather than surfacing it as a
       failure. */
    shares = error ? [] : (data || []);
    renderSharing();
}

export function renderSharing() {
    const host = $('#sharing-list');
    if (!host) return;

    if (!shares.length) {
        host.innerHTML = '<p class="empty">Only you have access to this profile.</p>';
        return;
    }

    host.innerHTML = shares.map((row) => {
        const isInvite = row.kind === 'invite';
        const who = row.email || 'Someone';
        const meta = isInvite
            ? `Invited${row.expires_at ? ` · expires ${new Date(row.expires_at).toLocaleDateString()}` : ''}`
            : `${row.role}${row.accepted_at ? ` · since ${new Date(row.accepted_at).toLocaleDateString()}` : ''}`;
        /* The owner row has no revoke button: revoke_profile_member
           refuses it server-side, so offering the button would only
           produce an error message. */
        const canRevoke = row.role !== 'owner';
        return `
        <div class="manage-row">
            <span class="reward-row__tile" aria-hidden="true">${isInvite ? '✉️' : '👤'}</span>
            <div class="manage-row__body">
                <div class="manage-row__title">${esc(who)}</div>
                <div class="manage-row__meta">${esc(meta)}</div>
            </div>
            ${isInvite ? `<button class="btn-ghost" data-invite-refresh="${esc(row.id)}">Resend</button>` : ''}
            ${canRevoke ? `<button class="btn-danger-quiet" data-share-revoke="${esc(row.id)}" data-share-kind="${esc(row.kind)}">Remove</button>` : ''}
        </div>`;
    }).join('');

    host.querySelectorAll('[data-invite-refresh]').forEach((b) =>
        b.addEventListener('click', () => refreshInvite(b.dataset.inviteRefresh)));
    host.querySelectorAll('[data-share-revoke]').forEach((b) =>
        b.addEventListener('click', () => revokeShare(b.dataset.shareRevoke, b.dataset.shareKind)));
}

async function refreshInvite(inviteId) {
    const { error } = await sb.rpc('refresh_profile_invite', { invite_id: inviteId });
    if (error) { toast(`Couldn’t resend: ${error.message}`); return; }
    toast('Invite resent.');
    await refreshShares();
}

async function revokeShare(id, kind) {
    const fn = kind === 'invite' ? 'revoke_profile_invite' : 'revoke_profile_member';
    const args = kind === 'invite' ? { invite_id: id } : { member_id: id };
    const { error } = await sb.rpc(fn, args);
    if (error) { toast(`Couldn’t remove: ${error.message}`); return; }
    toast(kind === 'invite' ? 'Invite cancelled.' : 'Access removed.');
    await refreshShares();
}

/* ── Referrals ─────────────────────────────────────────
 *
 * The marketing site already has an /r/ landing page for referral
 * links; the dashboard had no way to find out what your code is. One
 * RPC, which mints the code on first call and returns the same one
 * afterwards.
 */

export async function loadReferralCode() {
    const el = $('#referral-code');
    if (!el) return;
    const { data, error } = await sb.rpc('get_or_create_referral_code');
    if (error || !data) { el.textContent = '—'; return; }
    el.textContent = data;
    const link = $('#referral-link');
    if (link) link.value = `https://vigdisapp.is/r/?code=${encodeURIComponent(data)}`;
}

async function copyReferralCode() {
    const link = $('#referral-link');
    if (!link?.value) return;
    try {
        await navigator.clipboard.writeText(link.value);
        toast('Referral link copied.');
    } catch {
        /* Clipboard access is blocked in some browsers unless the page
           is focused and the gesture is trusted. Selecting the text is
           the honest fallback — the user can still copy it. */
        link.select();
        toast('Press ⌘C to copy the link.');
    }
}

/* ── Do Mode ───────────────────────────────────────────
 *
 * The app's guided run-through, in the form the web can honestly
 * support: one remaining task at a time, big, with a single obvious
 * action.
 *
 * Not a port of the phone version, and deliberately so. On the phone
 * Do Mode is a child holding the device and working down their own
 * list; on a laptop it is a parent and child at a table looking at the
 * same screen. What survives that move is the one-thing-at-a-time
 * framing — what does not is the swipe choreography, which would be
 * imitation for its own sake.
 *
 * Completion goes through the same `toggleTask` the task list uses, so
 * points, streaks and the celebration all behave identically whether a
 * task was ticked here or there.
 */

let doQueue = [];
let doIndex = 0;

function bindDoModeUI() {
    $('#btn-do-mode')?.addEventListener('click', startDoMode);
    $('#btn-do-done')?.addEventListener('click', completeCurrent);
    $('#btn-do-skip')?.addEventListener('click', () => { doIndex += 1; renderDoMode(); });
    $('#btn-do-close')?.addEventListener('click', () => $('#modal-do').close());
}

/** Today's still-to-do tasks, in the order the child would meet them:
 *  by time period, then by the list's own order. */
function buildDoQueue() {
    const todayIso = new Date().toISOString().slice(0, 10);
    const periodOrder = new Map(
        state.data.timePeriods.map((tp) => [tp.id, tp.sort_order ?? 0]));

    return state.data.tasks
        .filter((t) => !t.deleted_at)
        .filter((t) => !(t.completion_history || []).some((ts) => String(ts).slice(0, 10) === todayIso))
        .sort((a, b) => {
            const pa = periodOrder.get(a.time_period_id) ?? 99;
            const pb = periodOrder.get(b.time_period_id) ?? 99;
            return pa - pb || (a.sort_order ?? 0) - (b.sort_order ?? 0);
        });
}

function startDoMode() {
    doQueue = buildDoQueue();
    doIndex = 0;
    renderDoMode();
    $('#modal-do').showModal();
}

function renderDoMode() {
    const body = $('#do-body');
    if (!body) return;

    if (doIndex >= doQueue.length) {
        /* Two different endings, because they mean different things: a
           genuinely empty list is worth celebrating, one you skipped
           your way to the end of is not. */
        const finished = doQueue.length > 0;
        body.innerHTML = `
            <div class="do-done">
                <img src="../assets/mascot/loa-greeting.svg" alt="" width="96">
                <h3>${finished ? 'That’s everything for today.' : 'Nothing left to do today.'}</h3>
                <p class="rnote">${finished
                    ? 'Anything skipped is still on the list.'
                    : 'Every task for today is already ticked off.'}</p>
            </div>`;
        $('#btn-do-done').hidden = true;
        $('#btn-do-skip').hidden = true;
        return;
    }

    const task = doQueue[doIndex];
    const period = state.data.timePeriods.find((tp) => tp.id === task.time_period_id);
    const steps = state.data.subtasks
        .filter((st) => st.task_id === task.id && !st.deleted_at)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    body.innerHTML = `
        <p class="do-progress">${doIndex + 1} of ${doQueue.length}${period ? ` · ${esc(period.name)}` : ''}</p>
        <div class="do-icon" aria-hidden="true">${esc(task.icon || '📝')}</div>
        <h3 class="do-title">${esc(task.title)}</h3>
        ${task.points ? `<p class="do-points">${task.points} points</p>` : ''}
        ${steps.length ? `<ul class="do-steps">${steps.map((st) =>
            `<li class="${st.is_completed ? 'is-done' : ''}">${esc(st.title)}</li>`).join('')}</ul>` : ''}
        ${task.notes ? `<p class="rnote">${esc(task.notes)}</p>` : ''}`;

    $('#btn-do-done').hidden = false;
    $('#btn-do-skip').hidden = false;
}

async function completeCurrent() {
    const task = doQueue[doIndex];
    if (!task) return;
    /* Reuse the task list's own toggle so this is the same write, the
       same server function and the same celebration — not a second
       implementation that can drift from it. */
    if (typeof toggleTask === 'function') await toggleTask(task.id);
    doIndex += 1;
    renderDoMode();
}

/* ── Theme parity with the app ─────────────────────────
 *
 * `selected_theme_raw` and `appearance_mode_raw` have been syncing from
 * the app since migration 0007, and the dashboard ignored both — a
 * parent who picked Ocean and dark mode on their phone still got a
 * light coral website. Nothing about that says "same product".
 *
 * The values are applied as attributes on <html>; themes.css does the
 * rest by overriding the same tokens the whole stylesheet already
 * reads. Cached to localStorage so the next load paints the right
 * colours immediately instead of flashing coral first.
 */

const SYSTEM_DARK = window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

export function applyProfileTheme(profile) {
    const root = document.documentElement;
    const theme = profile?.selected_theme_raw || 'coral';
    const appearance = profile?.appearance_mode_raw || 'light';

    root.setAttribute('data-theme', theme);
    root.setAttribute('data-appearance', resolveAppearance(appearance));

    try {
        localStorage.setItem('vigdis-web-theme', theme);
        localStorage.setItem('vigdis-web-appearance', appearance);
    } catch { /* private mode — the attributes above still applied */ }

    /* Only "system" needs to keep listening. A profile pinned to light
       or dark should not change when the laptop flips at sunset. */
    if (SYSTEM_DARK) {
        SYSTEM_DARK.onchange = appearance === 'system'
            ? () => root.setAttribute('data-appearance', resolveAppearance('system'))
            : null;
    }
}

function resolveAppearance(mode) {
    if (mode === 'dark') return 'dark';
    if (mode === 'system') return SYSTEM_DARK?.matches ? 'dark' : 'light';
    return 'light';
}
