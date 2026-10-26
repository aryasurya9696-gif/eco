-- ============================================================================
-- Migration: 20261207_mail_review_fixes.sql
-- Description: One stored copy of a message per user, not per platform.
--
-- uq_mail_messages_message_id_header was unique across every user. When one
-- Echo user mailed another, the sender's Sent copy took the Message-ID and the
-- recipient's inbound copy was dropped as a duplicate; one external mail sent
-- to two Echo customers reached only the first. The Message-ID is now unique
-- per user, which still stops a redelivered webhook from storing a message
-- twice for the same user.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

drop index if exists public.uq_mail_messages_message_id_header;

create unique index if not exists uq_mail_messages_user_message_id_header
  on public.mail_messages (user_id, message_id_header) where message_id_header is not null;
