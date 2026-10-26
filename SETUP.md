# Echo: clean deploy setup

Everything needed to bring Echo up on a **new, empty Supabase project**, in order.
Do the steps top to bottom. Each one says what breaks if you skip it.

> Tick the boxes as you go. Steps marked **optional** can be done later; the
> feature they belong to simply stays off until then.

---

## 0. Accounts and keys to collect first

| Service | What you need from it | Needed for |
|---|---|---|
| [Supabase](https://supabase.com) | A new project: **project ref**, **project URL**, **anon key**, **service role key**, **database password** | Everything |
| [treg.to](https://treg.to) | An org-scoped token (`trg_live_...`) with some balance | Feed sweeps, leads, company/person enrichment |
| [OpenAI](https://platform.openai.com) | API key | AI reply drafts, keyword suggestions |
| [Dodo Payments](https://dodopayments.com) | API key, webhook key, 3 product ids | Buying credits |
| [Resend](https://resend.com) *(optional)* | API key, a sending domain, an inbound webhook secret | Echo Mail |
| [X developer portal](https://developer.x.com) *(optional)* | OAuth 2.0 client id and secret | Replying on X from the feed |
| [Reddit apps](https://www.reddit.com/prefs/apps) *(optional)* | "web app" client id and secret | Replying on Reddit from the feed |
| A static host (Vercel, Netlify, Cloudflare Pages…) | Your app URL, e.g. `https://app.example.com` | The frontend |

You also need on your machine: **Node 20+**, and the **Supabase CLI** (`npx supabase` works).

Write your values down once. They are referred to below as:

```text
<ref>          new Supabase project ref        e.g. abcdefghijklmnop
<project-url>  https://<ref>.supabase.co
<anon-key>     Supabase anon (public) key
<app-origin>   where the frontend is served     e.g. https://app.example.com
```

> **Never put the service role key, treg token or any API key in `.env`.**
> Anything starting with `VITE_` ends up in the public JavaScript bundle.

---

## 1. Create the Supabase project

- [ ] Create the project in the Supabase dashboard and wait until it is ready.
- [ ] **Database → Extensions**: enable **`pg_cron`** and **`pg_net`**.
  - Without them nothing runs on a schedule: no automatic sweeps, no stale-hold
    reaper, no domain verification.
  - Vault (`supabase_vault`) is already on in every new project; the mailbox and
    social-account secrets need it.
- [ ] Log the CLI in and link it to the new project:

```bash
npx supabase login
npx supabase link --project-ref <ref>
```

---

## 2. Apply the database schema

- [ ] *(Optional, recommended)* Check the schema on a throwaway local Postgres first. This touches no real database:

```bash
npm i --no-save @electric-sql/pglite@0.2.17
node scripts/verify-deploy-local.cjs
```

  It must end with `all checks passed`.

- [ ] Dashboard → **SQL Editor** → paste the whole of [`supabase/deploy-all.sql`](supabase/deploy-all.sql) → **Run**.

Notes:
- It is safe to run more than once. Prices and other seeds are inserted once and are never overwritten later.
- Do **not** use `supabase db push`. The `migrations/` folder contains an abandoned
  design (`20261024`–`20261101`) that `deploy-all.sql` leaves out on purpose.

---

## 3. Server-side settings stored in the database

These live in `public.service_secrets` (only the service role can read it). The
cron jobs read them when they run.

- [ ] In the SQL Editor, fill in your values and run:

```sql
insert into public.service_secrets (name, value) values
  ('project_url',       'https://<ref>.supabase.co'),
  ('project_anon_key',  '<anon-key>'),
  ('sweep_cron_secret', encode(gen_random_bytes(32), 'hex')),
  ('treg_token',        '<your treg token>')
on conflict (name) do update set value = excluded.value, updated_at = now();

-- (Re)create the scheduled jobs from those values.
select public.configure_echo_cron();   -- hourly sweep + stale-hold reaper
select public.configure_mail_cron();   -- custom-domain verification every 10 min
```

- [ ] Check that the jobs exist:

```sql
select jobname, schedule from cron.job order by jobname;
-- expect: echo-daily-sweep, echo-reap-stale, echo-verify-domains
```

> Copy the `sweep_cron_secret` value (`select value from public.service_secrets where name = 'sweep_cron_secret';`).
> The same value goes into the `SWEEP_CRON_SECRET` function secret in step 4.

---

## 4. Edge function secrets

Put them in a local file that is **never committed**, for example `supabase/.secrets.env`, then push it in one go:

```bash
npx supabase secrets set --project-ref <ref> --env-file supabase/.secrets.env
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase automatically. Do not set them.

### Required

| Secret | Value | Used by | If missing |
|---|---|---|---|
| `TREG_TOKEN` | `trg_live_...` | `social-search`, `daily-sweep`, `leads` | Sweeps and leads answer 503 |
| `OPENAI_API_KEY` | `sk-...` | `ai` | Drafts fall back to templates |
| `APP_ORIGIN` | `<app-origin>` | `billing`, `social`, CORS everywhere | Checkout and social connect refuse to start |
| `ALLOWED_ORIGIN` | `<app-origin>` (comma-separate several) | CORS on every user-facing function | Only localhost may call the API |
| `SWEEP_CRON_SECRET` | the value from step 3 | `daily-sweep`, `mail` cron | Scheduled sweeps refuse to run |

### Payments (Dodo)

| Secret | Value |
|---|---|
| `DODO_PAYMENTS_API_KEY` | Dodo API key |
| `DODO_PAYMENTS_WEBHOOK_KEY` | `whsec_...` from the webhook you create in step 7 |
| `DODO_ENVIRONMENT` | `live_mode` for real money; anything else is test mode |

### Echo Mail *(optional)*

| Secret | Value |
|---|---|
| `RESEND_API_KEY` | `re_...` |
| `RESEND_WEBHOOK_SECRET` | Signing secret of the Resend inbound webhook (step 8) |
| `MAIL_SHARED_DOMAIN` | The shared domain Echo mailboxes live on, e.g. `mail.example.com`. Unset turns Echo mailboxes off |
| `MAIL_PLATFORM_DAILY_CAP` | Optional, default `2000` sends a day on the shared domain |
| `DOMAIN_CONNECT_*` | Optional one-click DNS setup; see the header of `supabase/functions/mail/index.ts` |

### Social replies *(optional)*

| Secret | Value |
|---|---|
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | From the X app (step 9) |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | From the Reddit app (step 9) |
| `REDDIT_USER_AGENT` | e.g. `web:echo:1.0 (by /u/yourname)` |

### Other optional ones

`OPENAI_MODEL` (default `gpt-4o-mini`), `OPENAI_PRICE_INPUT`, `OPENAI_PRICE_OUTPUT` (cost tracking only).

---

## 5. Deploy the edge functions

> `scripts/deploy-functions.cjs` refuses to run without `SUPABASE_PROJECT_REF`,
> so a deploy can never land in the wrong project by default.

```bash
# macOS / Linux / Git Bash
SUPABASE_PROJECT_REF=<ref> node scripts/deploy-functions.cjs
```

```powershell
# Windows PowerShell
$env:SUPABASE_PROJECT_REF = '<ref>'; node scripts/deploy-functions.cjs
```

The script deploys every function with the right JWT setting. Do not deploy them by hand:

| Function | JWT check at the gateway | Why |
|---|---|---|
| `ai`, `social-search`, `billing`, `leads`, `mail` | on | Called by the signed-in app |
| `daily-sweep` | **off** | Called by pg_cron with `x-sweep-secret` |
| `billing-webhook` | **off** | Dodo signs the body itself |
| `mail-inbound` | **off** | Resend signs the body itself |
| `social` | **off** | The X/Reddit redirect carries no JWT; every action checks it in code |

- [ ] Check that the scheduled sweep can really reach its function:

```bash
node scripts/verify-sweep-cron.cjs
```

---

## 6. Authentication settings (Supabase dashboard)

- [ ] **Authentication → URL Configuration**
  - **Site URL**: `<app-origin>`
  - **Redirect URLs**: add `<app-origin>/**` (and `http://localhost:5173/**` if you develop locally against this project)
- [ ] **Authentication → Providers → Email**: turn on **Leaked password protection**.
- [ ] *(Recommended for production)* **Authentication → Emails → SMTP**: use your own SMTP. The built-in sender is heavily rate-limited.

---

## 7. Payments (Dodo)

- [ ] Create three one-time products in Dodo: 200 credits / $10, 500 / $25, 1,000 / $50.
- [ ] Store their ids (checkout refuses a package without one):

```sql
update public.topup_packages set provider_ref = 'pdt_...' where code = 'starter_200';
update public.topup_packages set provider_ref = 'pdt_...' where code = 'standard_500';
update public.topup_packages set provider_ref = 'pdt_...' where code = 'pack_1000';
```

- [ ] Create a webhook in Dodo for payments and refunds pointing to
  `https://<ref>.supabase.co/functions/v1/billing-webhook`, and put its secret in `DODO_PAYMENTS_WEBHOOK_KEY`.

---

## 8. Echo Mail *(optional)*

- [ ] In Resend, add and verify the shared domain you set as `MAIL_SHARED_DOMAIN`.
- [ ] Register that domain in the database. This is a one-off, service-role only RPC,
  `public.configure_platform_mail_domain(...)`. Its arguments are described in the header of
  `supabase/migrations/20261129_platform_mailboxes.sql`.
- [ ] Resend → inbound / webhooks: send inbound mail and delivery events to
  `https://<ref>.supabase.co/functions/v1/mail-inbound`, and put the signing secret in `RESEND_WEBHOOK_SECRET`.

---

## 9. Social replies *(optional)*

Both apps use the same redirect URI:

```text
https://<ref>.supabase.co/functions/v1/social
```

**X**
- [ ] Developer portal → your app → **User authentication settings**:
  - OAuth 2.0 on, type **Web App (confidential client)**
  - Permissions: **Read and write**
  - Callback URI: the redirect URI above; Website URL: `<app-origin>`
- [ ] Copy the OAuth 2.0 **Client ID** and **Client Secret** into `X_CLIENT_ID` / `X_CLIENT_SECRET`.
- [ ] Your X API plan must allow posting. X charges the app owner about $0.015 per reply.

**Reddit**
- [ ] [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) → create app → type **web app** → redirect uri: the URI above.
- [ ] Copy the id (under the app name) and the secret into `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`.
- [ ] Reddit asks for approval before commercial API use. Check their current Data API terms before going live.

After setting these secrets, redeploy `social` so it picks them up:

```bash
SUPABASE_PROJECT_REF=<ref> node scripts/deploy-functions.cjs social
```

---

## 10. Frontend

- [ ] Create `.env` from [`.env.example`](.env.example) with only the two public values:

```env
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
```

- [ ] Build and deploy:

```bash
npm install
npm run build        # output in dist/
```

- [ ] On your host:
  - build command `npm run build`, output folder `dist`
  - set the same two `VITE_` variables in the host's environment settings
  - the app routes with `#` hashes, so no rewrite rules are needed
- [ ] The URL the site is served from must match `APP_ORIGIN` / `ALLOWED_ORIGIN`
  exactly (scheme + host, no trailing slash). Otherwise every API call fails CORS.

---

## 11. treg balance and Phase 0 check

- [ ] Top up the treg org. Sweeps refuse to run when the treg balance is below **$0.50**.
- [ ] *(Recommended)* Run the enrichment spike once with the new token, to see real answers and costs:

```bash
TREG_TOKEN=trg_live_... node scripts/treg-spike.cjs stripe.com
```

---

## 12. Smoke test after deploy

Do these in the live app, in order:

- [ ] Sign up a new account. Onboarding opens and the wallet shows **20 welcome credits**.
- [ ] Add a keyword. **Run sweep** returns mentions in the feed.
- [ ] **Draft reply** on a mention returns an AI draft.
- [ ] Billing: buy the smallest pack in Dodo **test mode**. Credits arrive within a few seconds; that proves the webhook.
- [ ] Leads: run a search, reveal one email, and check that the wallet goes down.
- [ ] Click a company name → **Get company profile** → profile shows (0.5 credit).
- [ ] *(Mail)* Claim an Echo mailbox, send yourself an email, and reply to it. The reply shows in the inbox.
- [ ] *(Social)* Settings → **Connect X** → approve → the account shows. Reply to one X mention from the draft dialog.
- [ ] Next hour: `select status_code from net._http_response order by id desc limit 5;` shows `200` for the scheduled sweep.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every request fails with a CORS error | `ALLOWED_ORIGIN` / `APP_ORIGIN` does not match the site URL exactly |
| "Leads service is not configured" (503) | `TREG_TOKEN` not set, or functions not redeployed after setting it |
| Sweeps never run on their own | `pg_cron`/`pg_net` off, `project_url` missing in step 3, or `SWEEP_CRON_SECRET` ≠ `sweep_cron_secret` |
| Scheduled sweep returns 401 | `daily-sweep` was deployed with JWT on; redeploy with the script |
| Payment succeeds but no credits | Webhook URL or `DODO_PAYMENTS_WEBHOOK_KEY` wrong, or `provider_ref` not set |
| "This feature is temporarily unavailable (pricing is not configured)" | `deploy-all.sql` not fully applied; re-run it |
| Connect X/Reddit button disabled | `X_CLIENT_*` / `REDDIT_CLIENT_*` not set, or `social` not redeployed |
| Social connect ends with "expired" | The consent screen took over 10 minutes, or the redirect URI in the X/Reddit app does not match exactly |

More detail on the database side is in [`supabase/README.md`](supabase/README.md).
