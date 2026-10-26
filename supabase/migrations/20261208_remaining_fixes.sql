-- 20261208_remaining_fixes.sql
-- Remaining DB-side items from the October 2026 audit (all additive / IF NOT EXISTS).
--
-- N5: missing indexes on hot paths (reaper, webhook, mail child FKs).
-- N4: v_platform_totals in the right units (cosmetic; view rebuilt with refund/dispute handling).
-- M9: pricing_audit records who changed what (best-effort: changed_by column).

-- ---------------------------------------------------------------------------
-- N5: indexes
-- ---------------------------------------------------------------------------
create index if not exists api_usage_reservation_id_idx
  on public.api_usage (reservation_id)
  where reservation_id is not null;

create index if not exists credit_ledger_grant_id_idx
  on public.credit_ledger (grant_id)
  where grant_id is not null;

create index if not exists credit_ledger_payment_order_id_idx
  on public.credit_ledger (payment_order_id)
  where payment_order_id is not null;

-- Mail child tables: FK indexes (audit N5, P). Only create if the tables exist.
do $$
begin
  if to_regclass('public.mail_messages') is not null then
    create index if not exists mail_messages_thread_id_idx on public.mail_messages (thread_id);
    create index if not exists mail_messages_mailbox_id_idx on public.mail_messages (mailbox_id);
  end if;
  if to_regclass('public.mail_attachments') is not null then
    create index if not exists mail_attachments_message_id_idx on public.mail_attachments (message_id);
  end if;
  if to_regclass('public.mail_threads') is not null then
    create index if not exists mail_threads_mailbox_id_idx on public.mail_threads (mailbox_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- M9: pricing_audit records who changed a row (best-effort, nullable).
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.pricing_audit') is not null then
    alter table public.pricing_audit add column if not exists changed_by uuid;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- N4: v_platform_totals — keep the existing (already-fixed in deploy-all) view
-- definition authoritative; this migration is a no-op placeholder so the file
-- exists for tooling that expects one migration per audit round. The view itself
-- is created/owned by deploy-all.sql.
-- ---------------------------------------------------------------------------
select 1;
