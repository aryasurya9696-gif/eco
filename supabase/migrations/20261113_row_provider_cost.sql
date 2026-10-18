-- lead_rows.treg_cost_usd: what this one row actually cost the provider
-- ---------------------------------------------------------------------------
-- The run has carried treg_cost_usd since it was created, so the margin for a
-- whole run is known. The margin for a single row is not, and the single row is
-- where the question actually gets asked: "this lead cost me 1.1 credits, what
-- did the provider charge you for it?"
--
-- Without it the user can see what they paid and never what it cost, which makes
-- the price unauditable. A per-result waterfall's entire claim is that the charge
-- is the measured provider cost at a mark-up, and the mark-up being visible per
-- row is what makes the claim checkable rather than asserted.
--
-- Nullable, deliberately. A row that has not been worked has no provider cost,
-- and zero is not the same as nothing: zero would read as "this was free" on a
-- row that is still queued. The UI shows a dash for null, which is what
-- PendingCount already does for a count that has not arrived.
--
-- Written by the worker in the same update that writes credits, so the two can
-- never be out of step for a row. There is no path that charges without costing
-- or costs without charging.

alter table public.lead_rows
  add column if not exists treg_cost_usd numeric(20,6);

comment on column public.lead_rows.treg_cost_usd is
  'What the provider actually charged for this row. Null until the row has been worked.';

-- A partial index rather than none. The table grows by the thousand per run and
-- the only read is "show me the cost for the rows on this page", which is
-- filtered by run. An index on run_id alone would be wrong — the export and the
-- provider lab read costs across every run at once.
create index if not exists lead_rows_run_treg_cost_idx
  on public.lead_rows (run_id)
  where treg_cost_usd is not null;