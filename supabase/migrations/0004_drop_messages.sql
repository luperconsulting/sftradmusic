-- NOT APPLIED. Run this yourself on the preview Supabase project.
-- 0003_messages.sql was already applied there. This drops those tables.
-- In-portal messages are gone. Students and the teacher use email instead.
-- Do not run this against a database that still needs those tables.

drop table if exists public.messages;
drop table if exists public.message_threads;
