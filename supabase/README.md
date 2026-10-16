# Echo — Supabase Setup & Deployment Guide

This directory contains the database migration and the Edge Function for **Echo**, the automated keyword lead monitor for X and LinkedIn.

---

## 1. Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) installed (`npm install -g supabase` or `scoop bucket add supabase https://github.com/supabase/scoop-bucket.git && scoop install supabase`)
- A Supabase Project created at [supabase.com](https://supabase.com)
- A SocialFetch API key from [socialfetch.dev](https://socialfetch.dev)

---

## 2. Apply Database Schema

### Option A: Via Supabase Dashboard (Fastest)
1. Navigate to your Supabase project dashboard -> **SQL Editor**.
2. Open `supabase/migrations/20250101000000_echo_schema.sql` and paste the contents into the query editor.
3. Click **Run**.

### Option B: Via Supabase CLI
```bash
supabase link --project-ref <YOUR_PROJECT_REF>
supabase db push
```

---

## 3. Disable Email Confirmations (Required for Instant Signup)

As per the PRD spec, enable immediate sign-in without email verification:
1. Go to Supabase Dashboard -> **Authentication** -> **Providers**.
2. Select **Email**.
3. Toggle **"Confirm email"** to **OFF**.
4. Click **Save**.

---

## 4. Set Edge Function Secrets

Set the SocialFetch API key in Supabase secrets so the Edge Function can authenticate:

```bash
supabase secrets set SOCIALFETCH_API_KEY=sfk_your_socialfetch_key_here
```

*(Note: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are automatically injected by Supabase into Edge Functions).*

---

## 5. Deploy the Daily Sweep Edge Function

Deploy the function with `--no-verify-jwt` because it runs via cron / backend triggers using the service role:

```bash
supabase functions deploy daily-sweep --no-verify-jwt
```

---

## 6. Schedule Daily Sweep (06:00 UTC)

### Option A: Supabase Dashboard Schedule (UI)
1. Go to **Edge Functions** in your Supabase dashboard.
2. Click on `daily-sweep`.
3. Open the **Schedule** tab and set the cron expression:
   `0 6 * * *` (06:00 UTC every day).

### Option B: pg_cron + pg_net (SQL Editor)
Run the following in your Supabase SQL editor (replace `<PROJECT_REF>` and `<SERVICE_ROLE_KEY>`):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'daily-keyword-sweep',
  '0 6 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/daily-sweep',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || '<SERVICE_ROLE_KEY>',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

---

## 7. Frontend Environment Variables

Create `.env` in the root of the project with:

```env
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...<your-anon-key>
```
