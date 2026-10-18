-- ============================================================================
-- Echo Leads: one worker per run, and row claims that actually skip locked rows
-- ----------------------------------------------------------------------------
-- Two things the worker needed from the database and was doing through
-- PostgREST instead.
--
-- 1. A run lease. The worker re-invokes itself after every chunk and pg_cron
--    calls it every minute, so two workers on the same run is the normal case,
--    not an edge case. Both read the same chunk counter, both reserved under the
--    same idempotency key, and the second hold came back as a replay of the
--    first - so the second worker's rows were settled against a hold that was
--    already closed and were never charged. A lease makes the chunks of one run
--    strictly sequential.
--
-- 2. A row claim with FOR UPDATE SKIP LOCKED. The old claim was an UPDATE ...
--    LIMIT through PostgREST with no ORDER BY, which PostgREST does not support
--    as a limited update, and it claimed 25 rows to work 5 - leaving 20 locked
--    for five minutes and sizing the credit hold for all 25.
--
-- Both are service-role only, like every other function that moves work.
-- ============================================================================

alter table public.lead_runs
  add column if not exists lease_until timestamptz;

comment on column public.lead_runs.lease_until is
  'Held by the worker that is processing a chunk of this run. Null or past means free.';

-- ---------------------------------------------------------------------------
-- lead_claim_run: take the run for p_seconds, or return false
-- ---------------------------------------------------------------------------
create or replace function public.lead_claim_run(p_run_id uuid, p_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  update public.lead_runs
     set lease_until = now() + make_interval(secs => greatest(10, least(p_seconds, 600)))
   where id = p_run_id
     and status in ('queued', 'running')
     and (lease_until is null or lease_until < now())
  returning id into v_id;

  return v_id is not null;
end;
$$;

-- ---------------------------------------------------------------------------
-- lead_release_run: give the lease back early
-- ---------------------------------------------------------------------------
create or replace function public.lead_release_run(p_run_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.lead_runs set lease_until = null where id = p_run_id;
$$;

-- ---------------------------------------------------------------------------
-- lead_claim_rows: up to p_limit workable rows, oldest first, skipping held ones
-- ---------------------------------------------------------------------------
-- Ordered by (created_at, id) so a run is worked in the order it was found and
-- two rows created in the same statement still have a stable order. A retried
-- row reuses its provider idempotency keys, so a call that already happened is
-- replayed by Treg at no cost rather than bought again.
create or replace function public.lead_claim_rows(
  p_run_id uuid,
  p_limit integer,
  p_stale_seconds integer default 300
)
returns setof public.lead_rows
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with picked as (
    select r.id
      from public.lead_rows r
     where r.run_id = p_run_id
       -- 'trying' too: a row left mid-step by a worker that died is only ever
       -- in that state, and without it the run could never finish. The stale
       -- lock below is what keeps a row another worker is on from being taken.
       and r.state in ('queued', 'miss', 'trying')
       and (r.locked_at is null
            or r.locked_at < now() - make_interval(secs => greatest(30, p_stale_seconds)))
     order by r.created_at, r.id
     limit greatest(1, least(p_limit, 100))
     for update skip locked
  )
  update public.lead_rows r
     set locked_at = now(),
         locked_by = 'worker'
    from picked
   where r.id = picked.id
  returning r.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- lead_run_add_totals: add a chunk's charge and cost to the run, atomically
-- ---------------------------------------------------------------------------
-- An increment in SQL rather than "snapshot + amount" from the worker. The
-- worker's copy of the run was read before it took the lease, so writing
-- snapshot + amount overwrote whatever another worker had settled meanwhile.
create or replace function public.lead_run_add_totals(
  p_run_id uuid,
  p_credits numeric,
  p_cost_usd numeric,
  p_chunks integer default 0
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $
  update public.lead_runs
     set charged_credits = charged_credits + greatest(coalesce(p_credits, 0), 0),
         treg_cost_usd   = treg_cost_usd + greatest(coalesce(p_cost_usd, 0), 0),
         started_at      = coalesce(started_at, now()),
         counters        = jsonb_set(counters, '{chunk}',
                             to_jsonb(coalesce((counters ->> 'chunk')::integer, 0) + greatest(p_chunks, 0)))
   where id = p_run_id;
$;

revoke execute on function public.lead_run_add_totals(uuid, numeric, numeric, integer) from public, anon, authenticated;
grant  execute on function public.lead_run_add_totals(uuid, numeric, numeric, integer) to service_role;

revoke execute on function public.lead_claim_run(uuid, integer)          from public, anon, authenticated;
revoke execute on function public.lead_release_run(uuid)                 from public, anon, authenticated;
revoke execute on function public.lead_claim_rows(uuid, integer, integer) from public, anon, authenticated;
grant  execute on function public.lead_claim_run(uuid, integer)          to service_role;
grant  execute on function public.lead_release_run(uuid)                 to service_role;
grant  execute on function public.lead_claim_rows(uuid, integer, integer) to service_role;

-- Stable paging for get_run: rows seeded in one insert share a created_at, so
-- the id is the tiebreak and the index covers both.
create index if not exists lead_rows_run_created_id_idx
  on public.lead_rows (run_id, created_at, id);
