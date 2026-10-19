-- =============================================================================
-- Migration: 20261122_user_leads.sql
-- Description: B2B Leads Discovery & Contact Intelligence table and pricing
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    first_name TEXT,
    last_name TEXT,
    full_name TEXT NOT NULL,
    title TEXT,
    company_name TEXT,
    company_domain TEXT,
    company_size TEXT,
    company_revenue TEXT,
    company_phone TEXT,
    linkedin_url TEXT,
    work_email TEXT,
    email_status TEXT, -- 'valid', 'accept_all', 'risky', 'invalid'
    email_confidence NUMERIC,
    phone_number TEXT,
    phone_type TEXT, -- 'mobile', 'landline'
    location TEXT,
    status TEXT NOT NULL DEFAULT 'new', -- 'new', 'contacted', 'replied', 'dismissed'
    notes TEXT,
    raw JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_user_lead_contact UNIQUE (user_id, company_domain, full_name)
);

CREATE INDEX IF NOT EXISTS idx_user_leads_user_id ON public.user_leads(user_id);
CREATE INDEX IF NOT EXISTS idx_user_leads_created_at ON public.user_leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_leads_status ON public.user_leads(user_id, status);

ALTER TABLE public.user_leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own leads" ON public.user_leads;
CREATE POLICY "Users can manage own leads" ON public.user_leads
    FOR ALL
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Pricing entries for Leads
INSERT INTO public.pricing_config (
    operation, display_name, provider_endpoint, provider_cost_usd, 
    cost_verified, cost_source, credits, enabled, version, effective_from, updated_at
)
VALUES 
    ('treg.people.search', 'B2B People Search', 'treg.people.search', 0.00049500, true, 'catalog', 0.000000, true, 1, now(), now()),
    ('treg.people.email.find', 'Work Email Reveal', 'treg.people.email.find', 0.00483400, true, 'catalog', 1.000000, true, 1, now(), now()),
    ('treg.people.phone.find', 'Direct Mobile Reveal', 'treg.people.phone.find', 0.02000000, true, 'catalog', 2.000000, true, 1, now(), now())
ON CONFLICT (operation) DO UPDATE 
SET 
    display_name = EXCLUDED.display_name,
    credits = EXCLUDED.credits,
    enabled = EXCLUDED.enabled,
    updated_at = now();
