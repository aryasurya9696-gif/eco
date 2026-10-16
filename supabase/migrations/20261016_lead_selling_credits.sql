-- ============================================================================
-- Echo — Lead Selling & Credit Unlocking Engine Schema
-- ============================================================================

-- 1. Add credits_balance to profiles
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS credits_balance integer NOT NULL DEFAULT 25,
ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

-- 2. Create lead_unlocks table
CREATE TABLE IF NOT EXISTS public.lead_unlocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES public.monitored_posts(id) ON DELETE CASCADE,
  credits_spent integer NOT NULL DEFAULT 3,
  verified_email text,
  email_status text DEFAULT 'verified',
  enrichment_provider text DEFAULT 'QuickEnrich',
  contact_name text,
  company_name text,
  company_domain text,
  linkedin_url text,
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, post_id)
);

ALTER TABLE public.lead_unlocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lead_unlocks_select_own"
  ON public.lead_unlocks FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "lead_unlocks_insert_own"
  ON public.lead_unlocks FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 3. Create credit_transactions table
CREATE TABLE IF NOT EXISTS public.credit_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount integer NOT NULL,
  type text NOT NULL, -- 'signup_bonus', 'topup', 'lead_unlock', 'refund'
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "credit_transactions_select_own"
  ON public.credit_transactions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "credit_transactions_insert_own"
  ON public.credit_transactions FOR INSERT
  WITH CHECK (auth.uid() = user_id);
