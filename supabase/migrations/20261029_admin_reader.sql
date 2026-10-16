-- ============================================================================
-- Admin reader for the billing dashboard
-- ----------------------------------------------------------------------------
-- public.billing_summary aggregates every user's money, so it is granted to
-- service_role only. A browser holding an authenticated JWT must not be able to
-- read it, which means the dashboard cannot query the views directly.
--
-- This function is the bridge. It is SECURITY DEFINER so it can read those
-- views, and it is gated on public.is_admin() so an ordinary authenticated user
-- calling it gets nothing. The key detail is that is_admin() is evaluated in the
-- function's own context, where RLS on profiles does not apply, otherwise an
-- admin could not read their own flag.
-- ============================================================================

create or replace function public.admin_billing_snapshot(p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_summary jsonb;
  v_rate    numeric;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'admin privileges required' using errcode = '42501';
  end if;

  select to_jsonb(s) into v_summary from public.billing_summary s;
  v_rate := public.credit_rate();

  return jsonb_build_object(
    'summary', v_summary,
    'users', (
      select coalesce(jsonb_agg(to_jsonb(u) order by u.cash_after_cost_usd desc), '[]'::jsonb)
        from (
          select * from public.billing_by_user
           order by cash_after_cost_usd desc
           limit greatest(1, least(p_limit, 500))
        ) u
    ),
    'operations', (
      select coalesce(jsonb_agg(to_jsonb(o)), '[]'::jsonb)
        from public.billing_by_operation o
    ),
    'months', (
      select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb)
        from (
          select * from public.billing_by_month
           where recognised_usd <> 0 or collected_usd <> 0
           order by month desc
        ) m
    ),
    'ledger', (
      select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb)
        from (
          select id, user_id, delta, balance_after, kind, source,
                 revenue_usd, service_cost_usd, note, created_at
            from public.credit_ledger
           order by created_at desc
           limit greatest(1, least(p_limit, 200))
        ) l
    ),
    'payments', (
      select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
        from (
          select id, user_id, kind, status, gross_usd, fee_usd, net_usd,
                 credits_granted, created_at
            from public.payments
           order by created_at desc
           limit greatest(1, least(p_limit, 200))
        ) p
    ),
    'operation_pricing', (
      select value from public.billing_config where key = 'operation_pricing'
    ),
    'credits_per_usd', v_rate
  );
end;
$fn$;

revoke execute on function public.admin_billing_snapshot(integer) from public, anon;
grant execute on function public.admin_billing_snapshot(integer) to authenticated;
