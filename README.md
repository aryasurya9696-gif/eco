# Echo — Social Lead Intelligence

Echo is an automated lead monitoring platform that tracks up to 10 user-defined keywords across **X (Twitter)** and **LinkedIn** via the **SocialFetch API**. Daily sweeps identify buyer-intent mentions from the past 24 hours and deliver deduplicated, high-intent lead cards directly into your feed.

---

## 🚀 Features

- **Strict Grayscale Scandinavian / Linear Aesthetic**: Monochrome luxury palette (`#f6f6f4` background, `#141414` typography, 58px grid lines, sharp corners) where only platform marks pop (X black square, LinkedIn `#0a66c2` square).
- **Interactive 4-Step Onboarding**:
  1. Full Name ("What should we call you?")
  2. Website URL ("What's your website?")
  3. Core Offer ("What do you sell — or what does your company do?")
  4. Keywords ("What should we watch for?") with pill inputs, suggestion chips, 10-keyword hard limit, and canvas-confetti celebration.
- **Unified Feed**:
  - Filter by platform (All / X / LinkedIn), active keyword dropdown, and free-text search.
  - Card view with author name, handle, avatar initials, relative time, matched keyword pill, and direct post link.
  - "Show more / Show less" post body expansion.
- **Keyword Management**:
  - Add / remove keywords with instant optimistic updates and toast notifications.
  - Server and client-side enforcement of 10 keywords maximum.
- **Supabase Edge Function (`daily-sweep`)**:
  - Deno TypeScript Edge Function.
  - Integrates with SocialFetch (`/v1/twitter/search` and `/v1/linkedin/posts/search`).
  - Bounded to 2 pages max per platform to protect API credit budgets.
  - Upserts to `monitored_posts` with `ON CONFLICT (user_id, post_url) DO NOTHING`.
  - Audited via `sweep_runs` table.
- **Postgres Database Schema**:
  - Row Level Security (RLS) on all tables (`profiles`, `keywords`, `monitored_posts`, `sweep_runs`).
  - Users only read their own data; `monitored_posts` can only be written by the Service Role.
  - Database triggers: auto-create profile on signup, update timestamp, enforce 10 keyword limit.

---

## 🛠 Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4, Framer Motion, Lucide React, canvas-confetti.
- **Backend & Auth**: Supabase (Postgres, Auth, Edge Functions, pg_cron/pg_net).
- **External Data**: SocialFetch API (`api.socialfetch.dev`).

---

## ⚡ Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment (Optional for Live Supabase)
Copy `.env.example` to `.env`:
```env
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...<your-anon-key>
```
*(Note: If no Supabase credentials are provided, Echo runs in an instant Local Sandbox / Mock mode so you can test all features immediately).*

### 3. Run Development Server
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## 🗄 Backend Setup (Supabase)

See detailed instructions in [`supabase/README.md`](supabase/README.md):
1. Apply [`supabase/migrations/20250101000000_echo_schema.sql`](supabase/migrations/20250101000000_echo_schema.sql) in your Supabase SQL Editor.
2. In Supabase Dashboard -> **Authentication** -> **Providers** -> **Email**, toggle **"Confirm email"** to **OFF** (for instant sign-in).
3. Set the SocialFetch secret:
   ```bash
   supabase secrets set SOCIALFETCH_API_KEY=sfk_your_key_here
   ```
4. Deploy the edge function:
   ```bash
   supabase functions deploy daily-sweep --no-verify-jwt
   ```
5. Schedule the daily sweep at `06:00 UTC` via Dashboard Schedule or `pg_cron`.
