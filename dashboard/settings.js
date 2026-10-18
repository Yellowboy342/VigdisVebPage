/* Settings — the app's Settings tab (Views/Settings/MoreView.swift) on
 * the web.
 *
 * Same shape as the app: one inset-grouped list that pushes sub-pages,
 * same section order, same row labels, icons and icon colours
 * (SettingsIcon: a white symbol on a 29 pt coloured tile). Rows for
 * things the web cannot do — notifications, calm mode, sounds &
 * haptics, backup, Protected mode, subscription purchase, the
 * suggestion board — are left out rather than shown dead.
 *
 * Everything the old Setup view could do is housed here: profile
 * preferences (written straight to the `profiles` row, as the app's
 * per-field controls do), sharing, time periods, rewards, bonus points,
 * achievements, focus-timer history, the referral link, CSV export and
 * sign-out.
 */

import {
    THEMES, APPEARANCES, LIST_STYLES, PROFILE_LANGUAGES,
    applyProfileTheme, openShareModal, openProfileModal, openBonusModal,
    canCreateProfile, renderTimePeriods, renderManageRewards,
    renderAchievements, renderTimerSessions,
} from './manage.js';

let ctx = null;
/* Where we are. `page` is one of the data-sp panes in index.html. */
const nav = { page: 'root', profileId: null, choice: null };
let query = '';

/* iOS system colours, as named in the Swift source (.blue, .green…). */
const C = {
    blue: '#007AFF', green: '#34C759', gray: '#8E8E93', orange: '#FF9500',
    red: '#FF3B30', pink: '#FF2D55', purple: '#AF52DE', indigo: '#5856D6',
    teal: '#30B0C7', yellow: '#FFCC00', coral: 'var(--coral)',
};

/* Theme primaries from Theme.swift, for the swatches on the theme page. */
const THEME_SWATCH = {
    coral: '#F0918F', ocean: '#3B82F6', forest: '#10B981', lavender: '#8B5CF6', sunset: '#F59E0B',
    midnight: '#6366F1', rose: '#E11D48', mint: '#14B8A6', berry: '#D946EF', slate: '#64748B',
    sunflower: '#EAB308', bubblegum: '#EC4899', sky: '#0EA5E9', matcha: '#84CC16', ruby: '#EF4444',
    tangerine: '#F97316', lagoon: '#06B6D4', lilac: '#A855F7', moss: '#65A30D', cocoa: '#92400E',
    ice: '#0891B2', grape: '#7E22CE', apricot: '#FB923C',
};

/* The app's names (Localization.swift, AppearanceMode, CompletionChime). */
const LIST_STYLE_LABEL = { standard: 'Bubbles (Kids)', traditional: 'Classic (List)', hero: 'Adventure (Big)' };
const APPEARANCE_LABEL = { light: 'Light', dark: 'Dark', system: 'System' };
const CHIMES = [
    ['felt', 'Soft Piano'], ['warmSynth', 'Warm Synth'], ['cleanPop', 'Clean Pop'], ['sunrise', 'Sunrise'],
    ['bounce', 'Bounce'], ['sparklePop', 'Sparkle Pop'], ['pluck', 'Pluck'], ['smile', 'Smile'],
    ['chime', 'Chime'], ['bloom', 'Bloom'], ['crystal', 'Crystal'], ['marimba', 'Marimba'],
    ['harp', 'Harp'], ['bellTree', 'Bell Tree'], ['glow', 'Glow'], ['deepWood', 'Wood'],
    ['boing', 'Boing'], ['bubble', 'Bubble'], ['coin', 'Coin'], ['whoosh', 'Whoosh'],
    ['twinkle', 'Twinkle'], ['popcorn', 'Popcorn'], ['systemTink', 'Tink'], ['systemTritone', 'Tritone'],
];

const SUPPORT_EMAIL = 'support@vigdisapp.is';
const REVIEW_URL = 'https://apps.apple.com/app/id6760764940?action=write-review';

export function initSettings(context) {
    ctx = context;
}

/* ── Small builders ── */

const esc = (v) => ctx.esc(v);
const label = (pairs, value, fallback) => (pairs.find(([k]) => k === value) || [null, fallback])[1];

function icon(sym, color) {
    return `<span class="grow__icon" style="--ic:${color}"><svg aria-hidden="true"><use href="#s-${sym}"/></svg></span>`;
}
const chevron = '<svg class="grow__chev" aria-hidden="true"><use href="#i-chev-right"/></svg>';
const external = '<svg class="grow__chev grow__chev--ext" aria-hidden="true"><use href="#s-external"/></svg>';

/** One tappable row: icon tile, label, optional grey value, chevron. */
function row({ id, sym, color, text, value, action, href, ext, attrs = '' }) {
    const inner = `${sym ? icon(sym, color) : ''}<span class="grow__label">${esc(text)}</span>`
        + `${value != null && value !== '' ? `<span class="grow__value">${esc(value)}</span>` : ''}`
        + (ext ? external : chevron);
    const search = `data-search="${esc(text.toLowerCase())}"`;
    if (href) {
        return `<a class="grow" href="${esc(href)}" ${ext ? 'target="_blank" rel="noopener"' : ''} ${search} ${attrs}>${inner}</a>`;
    }
    return `<button class="grow" type="button" ${id ? `id="${id}"` : ''} data-act="${esc(action || '')}" ${search} ${attrs}>${inner}</button>`;
}

function toggleRow({ sym, color, text, field, on }) {
    return `
        <label class="grow grow--toggle" data-search="${esc(text.toLowerCase())}">
            ${icon(sym, color)}
            <span class="grow__label">${esc(text)}</span>
            <input class="ios-switch" type="checkbox" data-field="${field}" ${on ? 'checked' : ''}>
        </label>`;
}

function group(rows, { head, foot } = {}) {
    return `<section class="grp-wrap">
        ${head ? `<h2 class="grp-head">${esc(head)}</h2>` : ''}
        <div class="grp">${rows.join('')}</div>
        ${foot ? `<p class="grp-foot">${esc(foot)}</p>` : ''}
    </section>`;
}

function avatar(p, size) {
    const initial = esc((p?.name || '?').trim().charAt(0).toUpperCase() || '?');
    return `<span class="set-avatar" style="--sz:${size}px">${p?.avatar_path
        ? `<img data-storage-path="${esc(p.avatar_path)}" alt="" hidden><span>${initial}</span>`
        : `<img class="set-avatar__loa" src="../assets/mascot/loa.svg" alt="">`}</span>`;
}

const profileById = (id) => ctx.state.profiles.find((p) => p.id === id);
const isOwner = (p) => !!p && (ctx.DEMO || p.owner_user_id === ctx.state.session?.user?.id);

/* ── Navigation ── */

const PARENT = {
    account: 'root', switch: 'root', profile: 'root', help: 'root', about: 'root',
    choice: 'profile', periods: 'profile', rewards: 'profile', achievements: 'profile', timers: 'profile',
};

function go(page, extra = {}) {
    Object.assign(nav, { page }, extra);
    ctx.renderHead();
    renderSettings();
    window.scrollTo({ top: 0 });
}

export function settingsBack() {
    go(PARENT[nav.page] || 'root');
}

/* No photo → Lóa's head, as ProfileAvatarView does. */

/** The large title and back label renderHead shows for this page. */
export function settingsHeader() {
    // Can run before initSettings (deep link to #settings at boot).
    if (!ctx) return { title: 'Settings', back: null };
    const p = profileById(nav.profileId);
    const titles = {
        root: 'Settings', account: 'Account', switch: 'Switch Profile', profile: p?.name || 'Profile',
        periods: 'Time Periods', rewards: 'Rewards', achievements: 'Achievements', timers: 'Focus Timer',
        help: 'Help & Support', about: 'About', choice: CHOICES[nav.choice]?.title || '',
    };
    const parent = PARENT[nav.page];
    return {
        title: titles[nav.page] || 'Settings',
        back: parent ? (parent === 'root' ? 'Settings' : (p?.name || 'Profile')) : null,
    };
}

/** Back to the root when the tab is chosen again from the tab bar. */
export function resetSettings() {
    nav.page = 'root';
}

/* ── Writes ── */

/* One field at a time, like the app's per-row controls. Optimistic,
   rolled back if the server refuses (RLS decides who may edit). */
async function patchProfile(p, patch) {
    const before = {};
    for (const k of Object.keys(patch)) before[k] = p[k];
    Object.assign(p, patch);
    if (p.id === ctx.state.activeProfileId
        && ('selected_theme_raw' in patch || 'appearance_mode_raw' in patch)) {
        applyProfileTheme(p);
    }
    ctx.renderAll();
    if (ctx.DEMO) return;
    const { error } = await ctx.sb.from('profiles').update(patch).eq('id', p.id);
    if (error) {
        Object.assign(p, before);
        if (p.id === ctx.state.activeProfileId) applyProfileTheme(p);
        ctx.renderAll();
        ctx.toast(`Couldn’t save that: ${error.message}`);
    }
}

/* ── Choice pages (Theme, Appearance, Language, List Style, Sound) ── */

const CHOICES = {
    theme: { title: 'Theme', field: 'selected_theme_raw', options: THEMES, fallback: 'coral', swatch: true },
    appearance: {
        title: 'Appearance', field: 'appearance_mode_raw', fallback: 'light',
        options: APPEARANCES.map(([k]) => [k, APPEARANCE_LABEL[k] || k]),
    },
    language: { title: 'Language', field: 'language', options: PROFILE_LANGUAGES, fallback: 'en' },
    listStyle: {
        title: 'List Style', field: 'task_list_style_raw', fallback: 'standard',
        options: LIST_STYLES.map(([k]) => [k, LIST_STYLE_LABEL[k] || k]),
    },
    sound: { title: 'Completion Sound', field: 'completion_chime_raw', options: CHIMES, fallback: 'felt' },
};

function renderChoice(host, p) {
    const c = CHOICES[nav.choice];
    if (!c || !p) { go('root'); return; }
    const current = p[c.field] || c.fallback;
    const options = c.options.some(([k]) => k === current) ? c.options : [[current, current], ...c.options];
    const rows = options.map(([k, text]) => `
        <button class="grow" type="button" data-pick="${esc(k)}" aria-pressed="${k === current}">
            ${c.swatch ? `<span class="grow__swatch" style="background:${THEME_SWATCH[k] || '#ccc'}"></span>` : ''}
            <span class="grow__label">${esc(text)}</span>
            ${k === current ? '<svg class="grow__check" aria-hidden="true"><use href="#s-check"/></svg>' : ''}
        </button>`);
    let html = '';
    if (nav.choice === 'sound') {
        html += group([toggleRow({
            sym: 'speaker', color: C.green, text: 'Play Sound', field: 'completion_sound_enabled',
            on: !!p.completion_sound_enabled,
        })], { foot: 'Plays in the app when a task is done.' });
    }
    html += group(rows);
    host.innerHTML = html;
    host.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
        patchProfile(p, { [c.field]: b.dataset.pick });
    }));
}

/* ── Pages ── */

function renderRoot(host) {
    const s = ctx.state;
    const me = s.profiles.find((p) => p.id === s.activeProfileId) || s.profiles[0];
    const email = ctx.DEMO ? 'Sample data' : (s.session?.user?.email || '');

    const account = `
        <button class="grow grow--account" type="button" data-act="account" data-search="account ${esc((me?.name || '').toLowerCase())}">
            ${avatar(me, 56)}
            <span class="grow__stack">
                <span class="grow__title">${esc(me?.name || 'Vigdís')}</span>
                <span class="grow__status">${ctx.DEMO ? 'Sample data' : 'Cloud account connected'}</span>
            </span>
            ${chevron}
        </button>`;

    const profileRows = s.profiles.map((p) => {
        const lang = p.language === 'is' ? 'Icelandic' : 'English';
        const value = isOwner(p) ? `${lang} · ${label(THEMES, p.selected_theme_raw, 'Coral')}` : `Shared · ${lang}`;
        return `
            <button class="grow grow--profile" type="button" data-profile-open="${esc(p.id)}" data-search="${esc((p.name || '').toLowerCase())} profile">
                ${avatar(p, 40)}
                <span class="grow__label">${esc(p.name || 'Profile')}</span>
                <span class="grow__value">${esc(value)}</span>
                ${chevron}
            </button>`;
    });
    if (s.profiles.length > 1) {
        profileRows.push(row({ sym: 'arrows', color: C.blue, text: 'Switch Profile', action: 'switch' }));
    }
    const gate = canCreateProfile();
    profileRows.push(row({
        sym: 'plus', color: C.green, text: 'Add Profile', action: 'add-profile',
        attrs: gate.allowed ? '' : `aria-disabled="true" title="${esc(gate.reason || '')}"`,
    }));

    host.innerHTML = `
        <label class="set-search">
            <svg aria-hidden="true"><use href="#s-search"/></svg>
            <input type="search" id="set-search" placeholder="Search" value="${esc(query)}" aria-label="Search settings">
        </label>
        ${group([account])}
        ${group(profileRows, { head: 'Profiles', foot: gate.allowed ? '' : gate.reason })}
        ${group([
            row({ sym: 'question', color: C.blue, text: 'Help & Support', action: 'help' }),
            row({ sym: 'info', color: C.gray, text: 'About', action: 'about' }),
        ])}
        <p class="set-empty" hidden>No results</p>
        <div class="set-loa">
            <img src="../assets/mascot/loa-greeting.svg" alt="" width="54" height="48">
            <span>Vigdís · web</span>
        </div>
        <span class="visually-hidden">${esc(email)}</span>`;

    host.querySelectorAll('[data-profile-open]').forEach((b) =>
        b.addEventListener('click', () => go('profile', { profileId: b.dataset.profileOpen })));

    const input = host.querySelector('#set-search');
    const filter = () => {
        query = input.value;
        const q = query.trim().toLowerCase();
        let any = false;
        host.querySelectorAll('.grp-wrap').forEach((g) => {
            let visible = 0;
            g.querySelectorAll('[data-search]').forEach((r) => {
                const hit = !q || r.dataset.search.includes(q);
                r.hidden = !hit;
                if (hit) visible += 1;
            });
            g.hidden = visible === 0;
            if (visible) any = true;
        });
        host.querySelector('.set-empty').hidden = any;
        host.querySelector('.set-loa').hidden = !!q;
    };
    input.addEventListener('input', filter);
    if (query) filter();
}

function renderAccount(host) {
    const s = ctx.state;
    const me = s.profiles.find((p) => p.id === s.activeProfileId);
    const email = ctx.DEMO ? 'Sample data' : (s.session?.user?.email || '—');
    host.innerHTML = `
        <div class="set-hero">${avatar(me, 96)}</div>
        ${group([`
            <div class="grow grow--static">
                <span class="grow__label">Email</span>
                <span class="grow__value grow__value--wrap">${esc(email)}</span>
            </div>`], { foot: 'The same account you use in the app.' })}
        ${group([`<button class="grow grow--danger" type="button" data-act="signout">Sign Out</button>`])}`;
}

function renderSwitch(host) {
    const s = ctx.state;
    host.innerHTML = group(s.profiles.map((p) => `
        <button class="grow grow--profile" type="button" data-switch="${esc(p.id)}">
            ${avatar(p, 40)}
            <span class="grow__label">${esc(p.name || 'Profile')}</span>
            ${p.id === s.activeProfileId ? '<svg class="grow__check" aria-hidden="true"><use href="#s-check"/></svg>' : ''}
        </button>`));
    host.querySelectorAll('[data-switch]').forEach((b) => b.addEventListener('click', async () => {
        await ctx.selectProfile(b.dataset.switch);
        go('root');
    }));
}

function renderProfile(host) {
    const p = profileById(nav.profileId);
    if (!p) { go('root'); return; }
    const owner = isOwner(p);
    const active = p.id === ctx.state.activeProfileId;
    const periods = active ? ctx.state.data.timePeriods.length : null;
    const rewards = active ? ctx.state.data.rewards.length : null;

    /* Periods, rewards and the progress lists are loaded for the profile
       on screen; opening them for another profile switches to it first. */
    host.innerHTML = `
        <div class="set-hero">
            ${avatar(p, 96)}
            <input class="set-name" id="set-name" type="text" maxlength="60" value="${esc(p.name || '')}"
                   aria-label="Name" ${owner ? '' : 'readonly'}>
        </div>
        ${group([
            row({ sym: 'palette', color: C.purple, text: 'Theme', value: label(THEMES, p.selected_theme_raw, 'Coral'), action: 'choice:theme' }),
            row({ sym: 'halfcircle', color: C.indigo, text: 'Appearance', value: APPEARANCE_LABEL[p.appearance_mode_raw || 'light'] || 'Light', action: 'choice:appearance' }),
            row({ sym: 'globe', color: C.blue, text: 'Language', value: label(PROFILE_LANGUAGES, p.language, 'English'), action: 'choice:language' }),
            row({ sym: 'list', color: C.gray, text: 'List Style', value: LIST_STYLE_LABEL[p.task_list_style_raw || 'standard'] || 'Bubbles (Kids)', action: 'choice:listStyle' }),
        ], { head: 'Appearance' })}
        ${group([
            toggleRow({ sym: 'star', color: C.orange, text: 'Score', field: 'show_score', on: p.show_score ?? true }),
            toggleRow({ sym: 'flame', color: C.red, text: 'Streak', field: 'show_streaks', on: p.show_streaks ?? true }),
            toggleRow({ sym: 'sparkles', color: C.pink, text: 'Confetti', field: 'show_confetti', on: p.show_confetti ?? true }),
        ], { head: 'Show', foot: 'Hidden things keep counting in the background.' })}
        ${group([
            row({ sym: 'speaker', color: C.green, text: 'Completion Sound',
                  value: p.completion_sound_enabled ? label(CHIMES, p.completion_chime_raw, 'Soft Piano') : 'Off',
                  action: 'choice:sound' }),
        ], { head: 'Sound' })}
        ${group([
            row({ sym: 'clock', color: C.teal, text: 'Time Periods', value: periods ?? '', action: 'sub:periods' }),
            row({ sym: 'gift', color: C.pink, text: 'Rewards', value: rewards ?? '', action: 'sub:rewards' }),
        ], { head: 'Routine' })}
        ${group([
            row({ sym: 'starplus', color: C.green, text: 'Award Points', action: 'bonus' }),
            row({ sym: 'trophy', color: C.yellow, text: 'Achievements', action: 'sub:achievements' }),
            row({ sym: 'timer', color: C.orange, text: 'Focus Timer', action: 'sub:timers' }),
        ], { head: 'Progress', foot: 'Award points for something that was never on the list.' })}
        ${group([
            owner
                ? row({ sym: 'people', color: C.green, text: 'Manage Sharing', action: 'share' })
                : `<div class="grow grow--static">${icon('people', C.gray)}<span class="grow__label grow__label--muted">Manage Sharing</span></div>`,
        ], { head: 'Sharing', foot: owner ? 'Invite family to share this profile.' : 'Only the owner or admin can manage sharing.' })}`;

    // The flame glyph lives in the header icon set; reuse it here.
    host.querySelectorAll('use[href="#s-flame"]').forEach((u) => u.setAttribute('href', '#i-flame'));

    host.querySelectorAll('.ios-switch').forEach((sw) => sw.addEventListener('change', () => {
        patchProfile(p, { [sw.dataset.field]: sw.checked });
    }));
    const name = host.querySelector('#set-name');
    const saveName = () => {
        const v = name.value.trim();
        if (!v) { name.value = p.name || ''; return; }
        if (v !== p.name) patchProfile(p, { name: v });
    };
    name.addEventListener('change', saveName);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
}

function renderHelp() {
    const host = document.getElementById('help-rows');
    host.innerHTML = [
        row({ sym: 'envelope', color: C.blue, text: 'Contact Support', href: `mailto:${SUPPORT_EMAIL}` }),
        row({ sym: 'share', color: C.green, text: 'Export My Data', action: 'export' }),
    ].join('');
}

function renderAbout(host) {
    const is = profileById(ctx.state.activeProfileId)?.language === 'is';
    host.innerHTML = group([
        row({ sym: 'star', color: C.orange, text: 'Rate Vigdís', href: REVIEW_URL, ext: true }),
        row({ sym: 'hand', color: C.blue, text: 'Privacy Policy', href: is ? '../lang/privacy-is.html' : '../privacy.html', ext: true }),
        row({ sym: 'doc', color: C.gray, text: 'Terms of Service', href: is ? '../lang/terms-is.html' : '../terms.html', ext: true }),
    ]);
}

/* ── Render + actions ── */

export function renderSettings() {
    const pane = document.querySelector('[data-pane="settings"]');
    if (!pane || pane.hidden || !ctx) return;
    document.querySelectorAll('[data-sp]').forEach((el) => { el.hidden = el.dataset.sp !== nav.page; });
    const host = document.querySelector(`[data-sp="${nav.page}"]`);
    const p = profileById(nav.profileId);

    switch (nav.page) {
        case 'root': renderRoot(host); break;
        case 'account': renderAccount(host); break;
        case 'switch': renderSwitch(host); break;
        case 'profile': renderProfile(host); break;
        case 'choice': renderChoice(host, p); break;
        case 'periods': renderTimePeriods(); break;
        case 'rewards': renderManageRewards(); break;
        case 'achievements': renderAchievements(); break;
        case 'timers': renderTimerSessions(); break;
        case 'help': renderHelp(); break;
        case 'about': renderAbout(host); break;
        default: break;
    }
    ctx.hydrateImages(pane);
}

/* One delegated listener for every [data-act] row, bound once. */
export function bindSettings() {
    document.querySelector('[data-pane="settings"]')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || !btn.dataset.act) return;
        const act = btn.dataset.act;
        const p = profileById(nav.profileId);

        if (act === 'account' || act === 'switch' || act === 'help' || act === 'about') { go(act); return; }
        if (act === 'add-profile') {
            const gate = canCreateProfile();
            if (!gate.allowed) { ctx.toast(gate.reason); return; }
            openProfileModal(null);
            return;
        }
        if (act === 'signout') { ctx.signOut(); return; }
        if (act === 'export') { ctx.exportCSV(); return; }
        if (act === 'share' && p) { openShareModal(p); return; }
        if (act === 'bonus' || act.startsWith('sub:')) {
            if (p && p.id !== ctx.state.activeProfileId) await ctx.selectProfile(p.id);
            if (act === 'bonus') { openBonusModal(); return; }
            go(act.slice(4));
            return;
        }
        if (act.startsWith('choice:')) { go('choice', { choice: act.slice(7) }); }
    });
}
