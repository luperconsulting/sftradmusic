-- NOT APPLIED. Run this yourself on the preview Supabase project only.
-- Do not run it against production. The portal API writes messages with the service role.
-- These policies are a second line of defense: a student session can read only that student's
-- threads, and a teacher (the studio admin; there is no separate admin role) can read all.
-- There are no insert, update, or delete policies, and nothing here sends email or SMS.

create table public.message_threads (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  subject text not null,
  created_at timestamptz not null default now()
);
create index message_threads_student_created_idx on public.message_threads (student_id, created_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.message_threads (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  author_account_id uuid references public.accounts (id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index messages_thread_created_idx on public.messages (thread_id, created_at);

alter table public.message_threads enable row level security;
alter table public.messages enable row level security;

create policy message_threads_read on public.message_threads
  for select using (public.is_teacher() or public.can_view_student(student_id));

create policy messages_read on public.messages
  for select using (public.is_teacher() or public.can_view_student(student_id));

revoke all on table public.message_threads from anon, public;
revoke all on table public.messages from anon, public;
grant select on table public.message_threads to authenticated;
grant select on table public.messages to authenticated;
