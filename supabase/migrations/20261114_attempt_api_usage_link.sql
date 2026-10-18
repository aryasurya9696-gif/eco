-- lead_attempts.api_usage_id: the wrong type, and therefore no foreign key
-- ---------------------------------------------------------------------------
-- The column was created, never written, and never related. logAttempt inserted
-- the attempt first and the api_usage row second, so the id did not exist when the
-- attempt was written, and nothing went back to fill it. Every row had null.
--
-- The foreign key could not be added either, which turns out to be why nobody
-- noticed sooner. The column is uuid and api_usage.id is bigint. The two have
-- never been able to reference each other, so the relationship existed only as a
-- naming convention in a comment.
--
-- Recast to bigint rather than recasting api_usage.id to uuid. api_usage.id is a
-- sequence-backed primary key with a partial index and a foreign key pointing at
-- it; converting it touches every writer and every reader for no benefit.
-- lead_attempts.api_usage_id holds nothing at all — it is null in every row, which
-- is the problem being fixed — so changing its type costs nothing.
--
-- ON DELETE SET NULL. Deleting a cost row must not delete the evidence that a
-- lookup was made, because the hit rates are computed from the attempts and a
-- provider that stopped being written to would slowly disappear from its own
-- ranking.

-- uuid does not cast straight to bigint, so it goes by way of text. The column
-- holds nothing, so nothing is lost on the way.
alter table public.lead_attempts
  alter column api_usage_id type bigint using (api_usage_id::text)::bigint;

alter table public.lead_attempts
  add constraint lead_attempts_api_usage_id_fkey
  foreign key (api_usage_id) references public.api_usage(id) on delete set null;

comment on column public.lead_attempts.api_usage_id is
  'The api_usage row for this call, carrying its http status and error code. Null when the cost write failed.';

-- The only read is "a row's attempts, with their failures", which is always by row
-- and always needs the link resolved. Covering api_usage_id means PostgREST can
-- embed the parent without a second lookup per attempt.
create index if not exists lead_attempts_row_api_usage_idx
  on public.lead_attempts (row_id, api_usage_id);