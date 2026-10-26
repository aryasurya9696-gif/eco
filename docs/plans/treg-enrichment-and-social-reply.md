# Plan: treg People & Company Enrichment + 1-Click Social Reply

*Written 2026-10-26 against branch `leads-lead-intelligence`. treg facts were read live from
`https://treg.to/catalog/*`, `/openapi.json`, `/integrate.md` and `/skill.md` on that date.*

---

## Status (2026-10-26)

| Phase | State |
|---|---|
| 0 Spike | `scripts/treg-spike.cjs` is ready. It needs a real `TREG_TOKEN`; not run yet. |
| 1 Company enrichment | Built: `companies` cache, `company-lookup` / `enrich-company`, CompanyPanel, the feed **Company** button, and "Find people at this company" (opens the Prospector with the domain filled in). |
| 2 Person enrichment | Built: `enrich-person` for saved and unsaved leads, a row action in results, cards and saved leads, a bulk action, and company size/industry filled from the cache. Industry and country are now saved on leads. |
| 3 Social reply | Built on **path D** (Echo's own OAuth apps) for X and Reddit. A timed-out reply is "uncertain": charged, and a resend needs confirmation. The OAuth code is finished by the signed-in user who started it. Token refreshes are serialised. |
| 4 Signals | Built: news, funding rounds (Aviato) and open jobs (treg jobs search) through `company-signal`, each cached and charged only when something is found. |

Decisions taken with defaults:
- Q1: companies already in the cache are free.
- Q3: replies on X that contain a link are refused.
- Q2 (our own X app) is implied by path D. Nothing posts until `X_CLIENT_*` / `REDDIT_CLIENT_*` are set.

Built differently from this plan:
- No `monitored_posts.external_post_id` column. The post id is read from `post_url` at reply time.
- No seniority or headline columns. treg's routed person contract does not return them.
- Quick Lookup does not enrich automatically, which would cost a credit on every lookup. The result card has its own Enrich action instead.

Verified locally:
- `node scripts/verify-deploy-local.cjs`: every migration applies and re-applies on PGlite. `enrichment_social_acceptance.sql` passes.
- `deno test` passes for `leads` and `social`, and `deno check` passes for both functions.

Not verified: anything against live treg, X or Reddit.

---

## 0. What treg actually offers (verified)

### Enrichment — two routed endpoints, same call style we already use

| Endpoint | Input (send all you know) | Miss means | Price |
|---|---|---|---|
| `treg.people.enrich` | `email` \| `linkedin_url` \| `linkedin_handle` \| `domain + full_name` \| `domain + first_name + last_name` | `output.full_name == null` | $0.000495 – $0.28 per hit, 27 providers, cheapest first. 2 of 27 bill misses. |
| `treg.companies.enrich` | `domain` \| `website` \| `name` \| `linkedin_url` \| `linkedin_handle` \| `email` | `output.name == null` | $0.000495 – $0.25 per hit, 28 providers. 7 of 28 bill misses. |

- Response: `{ output, raw, _treg: { served_by, tried } }`. `X-Treg-Served-By` names the provider.
- Control headers: `X-Treg-Route-Max-Cost` (default **$1** per call if we do not send it, so we must
  send it), `X-Treg-Route-Waterfall: 0` (stop at the first miss), `X-Treg-Route-Prefer` and
  `X-Treg-Route-Exclude`.
- Optional signal endpoints for a later phase:
  - `treg.companies.news` ($0.01)
  - `aviato.companies.funding_rounds` ($0.01)
  - `lusha.x.companies-signals` (hiring and headcount, $0.12 per result, expensive)
- Neither enrich endpoint accepts an X or Reddit handle. A mention author can only be enriched when
  we know a domain, a LinkedIn URL or an email.

### Social reply — what exists, and the blocker

| Platform | treg action | Notes |
|---|---|---|
| X | `x.x.post.reply` (`POST /2/tweets`, `own_account`) | $0.015 per reply, **$0.20 if the text contains a URL**. treg's own X app bills these to us. 403/404 when replies are restricted or the post was deleted. |
| LinkedIn | `linkedin.linkedin.user.post.create` only | Posts to your *own* feed. **There is no catalog action to comment on someone else's post.** |
| Reddit | none | No comment or submit action, and Reddit is not in `/oauth/providers`. |
| Instagram | `instagram.x.comment-reply-create` | Replies only on your own media. Not useful for Echo's feed. |

"Publish on socials" on the treg landing page means Postiz (X, IG reels, LinkedIn, YouTube posts). It
is publishing to your own account, not replying to other people's posts, and Postiz does not appear in
the catalog search.

**Blocker: treg OAuth connections belong to a team (org), not to an end user.**
- `POST /oauth/start` and `GET /connections` are org-scoped.
- `/call/<id>` has no header to pick which connection to use.
- With Echo's single `TREG_TOKEN`, every Echo user would reply as **the same X account**.
- `GET /orgs/{org_id}/agents/{user_id}/connection` together with `POST /orgs/{org_id}/agents`
  (`pinned_tags`) *suggests* per-agent connections, but this is not documented.
- Phase 0 must confirm this with treg (Discord: https://discord.gg/6mQYYfFMAn) before we build on it.

---

## 1. Where this lands in Echo today

| Area | Today | Gap |
|---|---|---|
| treg plumbing | `tregHeaders` `supabase/functions/leads/index.ts:155`, `UsageLog` `leads/lib.ts:236`, token via `resolveToken` `:275` | Reusable as-is |
| Lead data | `user_leads` (`20261122_user_leads.sql:6`): only flat `company_name/domain/size/revenue/phone` | No industry, country, seniority, company profile. `normalizeLead` drops `industry`/`country_code` |
| LinkedIn lookup | `QuickLookupView.tsx:46-61` guesses the name from the URL slug | No real profile enrichment |
| Company | Nothing (old `leads.company.enrich` was dropped in `20261121_remove_leads.sql:160`) | Whole feature missing |
| Feed reply | `FeedTab.tsx:581-694` draft modal: Copy draft + Open original | No send. `monitored_posts` has no platform post id |
| OAuth | `mailboxes.kind = 'oauth_send'` is only in a CHECK constraint | No token storage or flow. Vault helper pattern exists (`20261125_mail.sql:274-330`) |
| Billing | `pricing_config` + `wallet_reserve/settle/release` + `api_usage` | Add price rows only |

---

## 2. Feature A — People & Company Enrichment

### A1. Database (one migration, `20261130_enrichment.sql`)

1. **`companies`**: a shared cache keyed by domain, so we pay treg once per company and not once per user.
   - Columns:
     - `domain text primary key`, `name`, `industry`, `employee_count int`, `employee_range`,
       `revenue_range`, `founded_year int`, `hq_city`, `hq_country`
     - `linkedin_url`, `website`, `description`, `logo_url`, `technologies text[]`
     - `funding_total_usd numeric`, `last_funding_round`, `last_funding_at`
     - `served_by`, `raw jsonb`, `enriched_at timestamptz`, `miss_at timestamptz` (a negative cache)
   - RLS: authenticated users may SELECT. Only the service role may write.
   - Freshness: re-enrich after 90 days; retry a miss after 30 days.
2. **`user_leads`**: add these columns:
   - `industry`, `country_code`, `seniority`, `headline`, `person_location`
   - `twitter_url`, `github_url`, `person_enriched_at timestamptz`
   - `company_domain` already exists and joins to `companies.domain`, so no foreign key is needed.
   - Grants stay as they are: clients only UPDATE `status` and `notes`.
3. **`pricing_config`** rows (gate the seed with `data_migrations`, like `20261127_pricing`):
   - `treg.people.enrich`: 1 credit on a hit, cap `0.03`.
   - `treg.companies.enrich`: 0.5 credit on a hit, cap `0.02`.
   - 1 credit = $0.05 at 20 credits/$. Both caps leave margin even at the worst-case provider inside the cap.

### A2. Edge function: new actions in `supabase/functions/leads/index.ts`

All of them reuse `tregHeaders`, `UsageLog.track`, `reserveOnce` and `settleHold`.
- **`enrich-company`** `{ domain }`
  1. Normalise the domain.
  2. If the cache is fresh, return it. **No treg call. Still charge?** See open question Q1.
  3. Otherwise reserve credits.
  4. Call `POST /call/treg.companies.enrich` with `X-Treg-Route-Max-Cost: 0.02` and
     `Idempotency-Key: echo:company:<domain>:<day>`.
  5. A hit upserts into `companies` and settles. A miss writes `miss_at` and releases the hold
     (we pay treg's miss cost; it is logged in `api_usage`).
- **`bulk-enrich-company`** `{ domains[] }` (max 25)
  - Dedupes the list and serves cached domains for free.
  - Calls treg with a concurrency of 5.
  - Uses a new `RATE_LIMITS` bucket.
- **`enrich-person`** `{ lead_id }` or `{ linkedin_url | email | domain+full_name }`
  - Calls `treg.people.enrich` with `X-Treg-Route-Max-Cost: 0.03`.
  - On a hit, merges into `user_leads` through `mergeLeadRecord` (`lib.ts:154`), never overwriting a
    non-null value with null.
  - Also fills `company_domain` when it was missing, then chains `enrich-company` from the cache only.
- **Mapper**: `mapPersonOutput` / `mapCompanyOutput` go in `lib.ts`, with unit tests in
  `lib_test.ts`, the same style as `classifyEmail`. The provider output shape varies, so read
  `output.*` first and fall back to `raw`.
- **Fix while there**: persist `industry` and `country_code` from `normalizeLead` into the new columns.

### A3. Frontend

- `src/types/index.ts`: extend `B2BLead`; add a `Company` type.
- New `src/components/leads/CompanyPanel.tsx`: a slide-over showing logo, description, size, revenue,
  funding, tech and LinkedIn. It opens from a company name in `ResultsPanel.tsx` and `LeadCard.tsx`.
  - The button reads "Enrich company (0.5 cr)". It is free when the cache is fresh, if Q1 says so.
- `ResultsPanel.tsx` / Saved leads: an "Enrich" row action and a bulk action that calls `enrich-person`.
  New columns: Industry and Seniority. Add both to the CSV export at `:247`.
- `QuickLookupView.tsx`, LinkedIn mode: call `enrich-person` first, for a real name, title and
  company, then the existing email and phone reveal.
- `leads-store.ts`: `enrichCompany` and `enrichPerson` methods. Add both prices to `PUBLIC_PRICES` in
  `src/lib/constants.ts:81`, and settle-note labels to `usageLabel` (`src/lib/billing.ts:290`).

### A4. Feed → Lead ("who is this mention?")

`FeedCard.tsx` gets a "Find company" action.
- For **web and news** mentions, `author_handle` is `@domain`. Run `enrich-company` on it, and offer
  "Find people at this company", which opens the Prospector pre-filled with `company_domain`.
- For **X and Reddit**, treg cannot enrich from a handle. Leave the action out for now. A later option
  is to read the X profile's bio URL to get a domain; that needs a catalog check first.

---

## 3. Feature B — 1-Click Social Reply (X first)

### B0. Spike first (1–2 days, no product code)

1. Ask treg, and test on a sandbox team, whether a **per-agent token**
   (`POST /orgs/{org}/agents` with `pinned_tags: {customer: <uid>}`) followed by `POST /oauth/start`
   `{provider: "x"}` *using that agent token* yields a connection that only that token's `/call`
   requests use.
2. If yes, take **path T (treg-native)**. If no, take **path D (direct OAuth)**. Everything below is
   shared between the two except the token handling.

| | Path T: treg per-user connection | Path D: Echo's own X OAuth app |
|---|---|---|
| OAuth app | treg's (consent screen says treg/Crewlet) | Echo's own X developer app (OAuth 2.0 PKCE, scopes `tweet.read tweet.write users.read offline.access`) |
| Secret we store | the per-user treg agent token (Vault) | access and refresh tokens (Vault) |
| Call | `POST treg.to/call/x.x.post.reply` with the user's agent token | `POST api.x.com/2/tweets` directly |
| Cost | $0.015 per reply, billed via treg | $0.015 per reply on our X pay-per-use account |
| Reddit / LinkedIn later | not possible (no catalog actions) | Reddit possible (own app, `submit` scope, `POST /api/comment`). LinkedIn comments need Community Management API approval, which is hard |

### B1. Database (`20261201_social_accounts.sql`)

- **`social_accounts`**:
  - `id`, `user_id`, `platform` (`x`; later `reddit`), `handle`, `external_user_id`
  - `connection_kind` (`treg` | `direct`), `vault_secret_id`, `treg_connection_id`
  - `status` (`active` | `needs_reauth` | `revoked`), `scopes text[]`, `daily_reply_cap int default 50`
  - `created_at`, `last_used_at`
  - Unique `(user_id, platform, external_user_id)`.
  - RLS: the owner may SELECT. Writes go through the edge function only.
  - Vault store/get/delete helpers copied from the mailbox ones, plus a drop trigger.
- **`social_replies`**:
  - `id`, `user_id`, `post_id → monitored_posts`, `account_id → social_accounts`, `platform`, `text`
  - `external_reply_id`, `reply_url`, `status` (`sending` | `sent` | `failed`), `error_code`
  - `credits_charged`, `idempotency_key unique`, `created_at`
  - Partial unique `(post_id) where status in ('sending','sent')`, so a post gets one reply.
- **`monitored_posts`**: add `external_post_id text`. Backfill X rows from `post_url`
  (`/status/(\d+)`), and set it in `mapTwitter` (`social-search/index.ts:550`) and the `daily-sweep` copy.
- **`pricing_config`**: `social.reply.x` = 1 credit. We refuse a reply that contains a URL, because X
  charges $0.20 for it. Alternative: price it at 5 credits.

### B2. New edge function `supabase/functions/social`

| Action | What it does |
|---|---|
| `connect_start {platform}` | T: create or reuse the user's agent token, then `POST /oauth/start`, and return the consent URL plus `state`. D: build the PKCE URL with state stored server-side. |
| `connect_status {state}` | T: `GET /oauth/status/{state}`. D: the callback handler swaps the code for tokens and stores them in Vault. Then fetch `users/me`, save handle and id. |
| `list_accounts`, `disconnect` | Disconnect calls `DELETE /connections/{id}` (T), or revokes the token (D). Then the Vault row is deleted. |
| `reply {post_id, text, account_id}` | Steps listed below. |

`reply` steps:
1. Check the JWT, then the post owner, then platform = x, then that `external_post_id` exists.
2. Check that no reply exists yet.
3. Check the text: 280 characters or fewer, and no URL.
4. Take the per-account daily cap through `take_rate_limit`.
5. Run `wallet_reserve`.
6. Call X with `Idempotency-Key: echo:reply:<post_id>`.
7. On 201: store `data.id` and `reply_url`, set `monitored_posts.status = 'contacted'`, then settle.
8. On 401: mark the account `needs_reauth` and release the hold. On 403/404: mark the reply
   `failed` and release.

### B3. Frontend

- Settings: a "Connected social accounts" card with a Connect X button. It opens a popup and polls
  `connect_status`. Copy the pattern from `src/components/mail/AccountsPanel.tsx`, including the
  `needs_reauth` badge.
- Draft modal in `FeedTab.tsx:581-694`: a primary **"Reply as @handle"** button next to Copy draft.
  - It shows a live character count and the credit price.
  - It is disabled with a reason when there is no account, the platform is not X, or the text has a URL.
  - Copy draft and Open original stay as the fallback for every other platform.
- `FeedCard.tsx`: a "Replied" badge that links to `reply_url`.

### B4. Guardrails (not optional)

- A human always clicks Send on text they can see. **No auto-replies from sweeps.** X's automation
  rules forbid unsolicited automated replies, and a single banned account would end the feature.
- One reply per post, a daily cap per account, and the draft must be edited or confirmed.
- Never forward treg's team-level `402` or `429` bodies to the user (`integrate.md` warns about this).

---

## 4. Order of work

| Phase | Scope | Size |
|---|---|---|
| 0 | Spike: test the enrich response shapes with a few real domains and LinkedIn URLs, and record hit rate and cost from `X-Treg-Cost-Micro`. Settle the per-user OAuth question with treg. | 1–2 d |
| 1 | Company enrichment (A1 companies + A2 company actions + CompanyPanel + feed web → company) | 3–4 d |
| 2 | Person enrichment (A1 lead columns + `enrich-person` + Quick Lookup + bulk) | 3 d |
| 3 | X reply (B1–B4) on the path picked in phase 0 | 5–7 d |
| 4 | Optional: Reddit reply via direct OAuth; company news and funding signals on CompanyPanel | later |

Each phase ships with:
- a migration added to `supabase/deploy-all.sql`
- `lib_test.ts` tests for the mappers
- a `supabase/tests/*.sql` acceptance test for reserve/settle on the new operations

## 5. Open decisions

- **Q1**: Should a company served from the shared cache cost the user credits? Charging keeps the
  pricing simple and turns the cache into margin. Free is friendlier.
- **Q2**: For path D, are we willing to register our own X developer app and pay X's per-post rate?
  This is required if treg cannot do per-user connections.
- **Q3**: Should replies containing a link be blocked, or charged at 5 credits?
