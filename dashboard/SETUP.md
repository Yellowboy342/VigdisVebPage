# Dashboard setup — Supabase auth configuration

The dashboard at `/dashboard/` talks straight to the app's Supabase project.
Status as of 2026-07-10:

## ✅ Done — redirect URLs (2026-07-10)

`uri_allow_list` now contains, alongside the app's own deep links:
`https://vigdisapp.is/dashboard/`, `https://www.vigdisapp.is/dashboard/`,
and `http://localhost:4173/dashboard/` (local testing — remove when no longer needed).
`site_url` is untouched (`vigdis://auth-callback`).

## ✅ Email sign-in — live (2026-08-17)

This note used to say email was disabled. It isn't:
`GET /auth/v1/settings` reports `external.email: true`, so the provider has
been on for a while and `dashboard.js` was hiding a working form behind a
hardcoded `EMAIL_AUTH_ENABLED = false`. That flag is gone.

The form leads with a **one-time sign-in link** (`signInWithOtp`), not a
password box, because every account created so far came from Apple or
Google and therefore has no password — a password-only form would have
failed for 100% of current users. Password entry sits behind a "Use a
password instead" disclosure for anyone who sets one via the reset flow.

`shouldCreateUser: false` on the OTP call: accounts belong to the app. One
created here would have no profiles and nothing to show.

Nothing further to configure — but confirm the sender address and the
"Magic Link" email template read sensibly under Authentication → Emails,
since most users will now meet Vigdís' transactional mail for the first time.

## ⬜ Google sign-in on the web

Currently configured: native iOS client only
(`512860079281-pb8uq3026d50uk8lhk3hqhsv67g2tif1.apps.googleusercontent.com`).

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) →
   same project as the existing clients → **Create credentials → OAuth client ID → Web application**.
2. Authorized redirect URI: `https://vfdjirmowbjdmieeyjkl.supabase.co/auth/v1/callback`
3. Save the new client ID and secret to local files (never paste into chat):
   `~/.vigdis-google-web-client-id` and `~/.vigdis-google-web-secret` —
   then ask Claude to wire them in. Target state via the Management API:
   `external_google_client_id = "<WEB_ID>,<existing iOS ID>"` (web first,
   native kept so app sign-in is unaffected) + `external_google_secret`.

## ⬜ Apple sign-in on the web — BROKEN, needs a secret

Confirmed live on 2026-08-17:

    GET /auth/v1/authorize?provider=apple
    400 {"error_code":"validation_failed",
          "msg":"Unsupported provider: missing OAuth secret"}

The Apple toggle is on (so `/auth/v1/settings` claims `apple: true`) but no
client secret is set, and the only client ID is the native bundle ID
`com.vigdis.vigdis`. A native App ID is not a valid `client_id` for the web
flow, and the web flow additionally requires a signed client-secret JWT that
the native flow never needs — which is exactly why the iOS app works and the
website does not.

Until it is configured, the dashboard pre-flights the provider and shows
"Apple sign-in isn't set up for the website yet" instead of navigating the
user into that raw JSON error. The probe passes automatically once the
secret lands; no code change needed to turn it back on.

Currently configured: native bundle ID only (`com.vigdis.vigdis`).

1. [Apple Developer → Identifiers](https://developer.apple.com/account/resources/identifiers/list/serviceId) →
   **new Services ID** (e.g. `is.vigdisapp.web`), enable **Sign in with Apple**;
   domain `vfdjirmowbjdmieeyjkl.supabase.co`, return URL
   `https://vfdjirmowbjdmieeyjkl.supabase.co/auth/v1/callback`.
2. Create (or reuse) a **Sign in with Apple key** (.p8) under Keys; note the
   Key ID and your Team ID.
3. Save the .p8 locally (e.g. `~/.vigdis-apple-signin.p8`) and ask Claude to
   generate the client-secret JWT and wire it in. Target state:
   `external_apple_client_id = "is.vigdisapp.web,com.vigdis.vigdis"` +
   `external_apple_secret = <generated JWT>`.
4. ⚠️ Apple's client secret is a JWT valid for at most 6 months — set a
   reminder to regenerate it (same .p8, one command).

## What the dashboard can do (2026-08-17)

It used to be a viewer. It can now also set the day up:

- **Profiles** — create, rename, delete, language, task-list style, theme,
  appearance, completion sound, and the points/streaks/confetti toggles.
  Creation is gated on `active_profile_limit_for_user`, the same number the
  app reads. That gate lives in the client on purpose: the profile cap has
  no RLS policy behind it (`can_create_owned_profile` is defined but
  referenced by nothing), so a web client that skipped the check would be
  the easy way around the app's limit.
- **Time periods** — create, rename, re-time, recolour, reorder. Removal
  refuses while tasks still point at the period, because the FK cascades.
- **Rewards** — create, edit, price, remove.
- **Steps (subtasks)** — add, rename, reorder, remove, and tick off through
  `set_subtask_completion`. That function had existed the whole time with no
  caller on the web.
- **Recurrence** — editable in the task modal, writing `recurrence_days`
  and keeping `recurrence_pattern` in step with it.
- **Bonus points** — award or take back, with a reason.
- **Sharing** — invite by email, resend, revoke, and see who has access, all
  through the invite/member RPCs rather than touching the tables.
- **Referrals** — shows the account's code from `get_or_create_referral_code`.
- **Achievements and timer sessions** — read-only.
- **Do mode** — one remaining task at a time, completing through the same
  `toggleTask` path the list uses.

### Removing things is app-only (2026-08-17)

The Setup view can create and edit, but its Remove buttons are hidden
behind `DELETE_PROPAGATES_TO_APP = false` in `manage.js`.

A web delete sets `deleted_at`, which is exactly what the app's delete
does server-side. The difference is afterwards: `pull_changes` filters
`deleted_at is null` on all ten tables, so a tombstone is never
returned to any client. All ten `SyncableEntity.mergeInto`
implementations contain a working `if deletedAt != nil { delete local }`
branch that can never fire from a pull. Realtime does not help — it
debounces and then calls the same `pull_changes`. The only full
reconcile is `syncDeletedProfiles`, which is profiles-only and pushes
local deletions *up*.

Deleting in the app appears to work because the app removes its own
local copy first and pushes the tombstone after; the deleting device
never needs to be told. A second device does, and never is.

So a web delete would set `deleted_at` while the app kept showing the
row — one account in two states, and the row gone for good on the next
fresh sign-in. The delete code is written and works; the flag is off
because the propagation isn't there.

To turn it back on: drop the ten `and <t>.deleted_at is null` clauses
from `pull_changes` and flip the flag. Verified safe on the client side
— no merge will resurrect a tombstoned row. Not done here because the
backend was explicitly out of scope.

### Time period icons must be SF Symbol names

`time_periods.icon` is rendered by the app with
`Image(systemName: period.icon)`, so the value has to be a real SF
Symbol — and, to stay consistent with the app's own editor, one of the
twelve in `TimePeriodSettingsView.availableIcons`. The first web build
invented its own list ('sun', 'moon', 'bed', 'star'), none of which are
in that set and several of which are not SF Symbols at all, so editing
a period from the website blanked its icon in the app.

`manage.js` now offers exactly those twelve. An icon it does not
recognise is added to the picker as its own option and preserved on
save, so a value written by a newer app build is never silently
replaced by whatever sits at the top of the list.

Deliberately **not** built:

- **Profile photo and cover upload.** See the bug below.
- **PIN, child mode, calm mode.** Device-local in the app, not columns. A web
  toggle would appear to work and change nothing.
- **Web push notifications.** A different system from the app's local
  notifications; needs a service worker and a push backend.

## 🐞 Profile avatars never reach storage (app bug, found 2026-08-17)

`CloudImageStorageService` writes profile images to

    profiles/<profile-id>/avatar.jpg
    profiles/<profile-id>/cover.jpg

but the storage RLS resolver `cloud_image_profile_id()` only recognises
`profile-avatars/` and `profile-covers/` as prefixes. Anything under
`profiles/` falls through to the task/subtask/reward branches, matches
none of them, and returns **null**. The bucket policies then evaluate
`can_write_profile(null)` → `is_profile_member(null, …)` → `p.id = null`
→ false, so the upload is refused.

Task, subtask and reward images use matching prefixes and work, which is
exactly why this went unnoticed: task photos sync, profile pictures
silently do not.

Fix is one migration adding a `profiles` branch to the resolver (returning
`parts[2]::uuid`, same as the two hyphenated prefixes). Nothing needs
migrating — no avatar was ever successfully stored. The web dashboard
leaves photo upload out until this is done rather than shipping against a
path that cannot work.

## Notes

- The publishable key in `dashboard.js` is safe to ship — every table is
  protected by row-level security keyed to the signed-in user.
- Task completion, subtask completion and reward redemption go through the
  same server functions the app uses (`set_task_completion`,
  `set_subtask_completion`, `redeem_reward`), so points and streaks stay
  consistent and the app picks up web changes through its normal sync.
- The page is `noindex` and is not in `sitemap.xml` on purpose.
- Management-API access token: `~/.vigdis-supabase-token` still exists on
  disk but is **revoked** — it answers 401. Generate a fresh one (Supabase →
  Account → Access Tokens) into that same path if you want the remaining
  config done from the CLI rather than by hand in the dashboard, and revoke
  it again afterwards.
