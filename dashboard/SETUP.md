# Dashboard setup — Supabase auth configuration

The dashboard at `/dashboard/` talks straight to the app's Supabase project.
Status as of 2026-07-10:

## ✅ Done — redirect URLs (2026-07-10)

`uri_allow_list` now contains, alongside the app's own deep links:
`https://vigdisapp.is/dashboard/`, `https://www.vigdisapp.is/dashboard/`,
and `http://localhost:4173/dashboard/` (local testing — remove when no longer needed).
`site_url` is untouched (`vigdis://auth-callback`).

## ℹ️ Email/password — disabled on purpose

The project has `external_email_enabled = false`, so the dashboard hides its
email form (flip `EMAIL_AUTH_ENABLED` in `dashboard.js` if this ever changes).
All existing users signed up with Apple/Google, so this loses nothing.

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

## ⬜ Apple sign-in on the web

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

## Notes

- The publishable key in `dashboard.js` is safe to ship — every table is
  protected by row-level security keyed to the signed-in user.
- Task completion, subtask completion and reward redemption go through the
  same server functions the app uses (`set_task_completion`,
  `set_subtask_completion`, `redeem_reward`), so points and streaks stay
  consistent and the app picks up web changes through its normal sync.
- The page is `noindex` and is not in `sitemap.xml` on purpose.
- Management-API access token lives in `~/.vigdis-supabase-token` (delete it
  when configuration is finished, and revoke the token in the Supabase
  dashboard under Account → Access Tokens).
