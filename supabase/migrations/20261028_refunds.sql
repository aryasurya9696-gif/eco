-- ============================================================================
-- Refund handling
-- ----------------------------------------------------------------------------
-- A refund has to do two things the grant path does not: mark the original
-- payment so the revenue figures stop counting it, and take back the credits
-- that were paid for but never spent.
--
-- Credits already consumed are deliberately NOT clawed back. The search they
-- bought has been delivered and its cost has been incurred; taking the balance
-- negative to recover money for work already performed would make the ledger
-- describe something that did not happen.
-- ============================================================================

alter table public.payments
  add column if not exists provider_payment_intent text;

create index if not exists payments_payment_intent_idx
  on public.payments (provider_payment_intent)
  where provider_payment_intent is not null;

-- ---------------------------------------------------------------------------
-- Revoke what a refunded payment never spent
-- ---------------------------------------------------------------------------
-- Zeroes the grant's remaining balance and writes the matching ledger row, so
-- the balance a user sees still reconciles against the ledger.
create or replace function public.revoke_grant_credits(p_grant_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_grant public.credit_grants%rowtype;
  v_balance numeric;
  v_remaining numeric;
begin
  select * into v_grant from public.credit_grants where id = p_grant_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'grant_not_found');
  end if;

  v_remaining := v_grant.credits_remaining;
  if v_remaining <= 0 then
    return jsonb_build_object('ok', true, 'revoked', 0, 'balance_after', null);
  end if;

  select credit_balance into v_balance
    from public.profiles where id = v_grant.user_id for update;

  -- Floor at zero. If the user already spent past this grant, the balance stays
  -- at zero rather than going negative on a refund.
  v_balance := greatest(v_balance - v_remaining, 0);

  update public.credit_grants set credits_remaining = 0 where id = p_grant_id;
  update public.profiles
     set credit_balance = v_balance, updated_at = now()
   where id = v_grant.user_id;

  insert into public.credit_ledger (
    user_id, delta, balance_after, kind, source, grant_id, revenue_usd, note
  ) values (
    v_grant.user_id, -v_remaining, v_balance, 'refund', 'refund', p_grant_id,
    -- Removes the deferred revenue that was sitting against these credits.
    -(v_remaining * v_grant.unit_price_usd),
    coalesce(p_note, 'Credits revoked on refund')
  );

  return jsonb_build_object('ok', true, 'revoked', v_remaining, 'balance_after', v_balance);
end;
$fn$;

revoke execute on function public.revoke_grant_credits(uuid, text) from public, anon, authenticated;
grant execute on function public.revoke_grant_credits(uuid, text) to service_role;
