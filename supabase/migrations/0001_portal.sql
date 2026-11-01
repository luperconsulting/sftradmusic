-- SF Trad Music portal schema. Holds what GoHighLevel can't hold privately: portal accounts, account-to-contact
-- mappings, notes, video metadata and assignments. Appointments and invoices stay in GoHighLevel.
-- The API uses the service role. RLS below is a second line of defense in case the anon key is ever used directly.

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  role text not null check (role in ('teacher', 'guardian', 'student')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  email text not null,
  display_name text not null,
  ghl_contact_id text,
  created_at timestamptz not null default now()
);

create table public.students (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  full_name text not null,
  style_line text not null default '',
  format text not null default 'In person' check (format in ('In person', 'Zoom')),
  is_minor boolean not null default true,
  guardian_name text,
  guardian_email text,
  student_since date,
  ghl_contact_id text not null unique,
  billing_contact_id text not null,
  created_at timestamptz not null default now()
);

create table public.account_students (
  account_id uuid not null references public.accounts (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  can_book boolean not null default true,
  can_pay boolean not null default true,
  primary key (account_id, student_id)
);

create table public.lesson_notes (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  author_account_id uuid references public.accounts (id) on delete set null,
  lesson_date date not null,
  title text not null default '',
  summary text not null default '',
  technique text not null default '',
  practice text not null default '',
  goals text not null default '',
  prep text not null default '',
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.lesson_notes (student_id, lesson_date desc);

create table public.videos (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null,
  description text not null default '',
  duration_label text not null default '—',
  source text not null check (source in ('upload', 'url')),
  external_url text,
  storage_path text,
  created_at timestamptz not null default now()
);

create table public.video_assignments (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  assigned_at timestamptz not null default now(),
  watched_at timestamptz,
  unique (video_id, student_id)
);

create table public.practice_assignments (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  instructions text not null default '',
  due_date date,
  video_id uuid references public.videos (id) on delete set null,
  lesson_date date,
  created_at timestamptz not null default now()
);

create table public.practice_assignment_students (
  assignment_id uuid not null references public.practice_assignments (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  completed_at timestamptz,
  primary key (assignment_id, student_id)
);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  method text not null check (method in ('email', 'code')),
  email text not null,
  name text not null,
  role text not null check (role in ('guardian', 'student')),
  student_ids uuid[] not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  expires_at timestamptz not null,
  preview jsonb not null default '{}',
  sent_at timestamptz not null default now()
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_account_id uuid,
  action text not null,
  target text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Helpers run as definer so policies can read accounts without recursing through RLS.
create function public.current_account_id() returns uuid
  language sql stable security definer set search_path = public as
  $$ select id from accounts where user_id = auth.uid() and status = 'active' $$;

create function public.is_teacher() returns boolean
  language sql stable security definer set search_path = public as
  $$ select exists (select 1 from accounts where user_id = auth.uid() and role = 'teacher' and status = 'active') $$;

create function public.can_view_student(sid uuid) returns boolean
  language sql stable security definer set search_path = public as
  $$ select public.is_teacher() or exists (
       select 1 from account_students where account_id = public.current_account_id() and student_id = sid) $$;

alter table public.accounts enable row level security;
alter table public.students enable row level security;
alter table public.account_students enable row level security;
alter table public.lesson_notes enable row level security;
alter table public.videos enable row level security;
alter table public.video_assignments enable row level security;
alter table public.practice_assignments enable row level security;
alter table public.practice_assignment_students enable row level security;
alter table public.invitations enable row level security;
alter table public.audit_log enable row level security;

-- Read-only policies. No write policies exist, so all writes must go through the API's checks.
create policy accounts_self on public.accounts for select using (user_id = auth.uid() or public.is_teacher());
create policy students_read on public.students for select using (public.can_view_student(id));
create policy links_read on public.account_students for select using (account_id = public.current_account_id() or public.is_teacher());
create policy notes_read on public.lesson_notes for select using (
  public.is_teacher() or (status = 'published' and public.can_view_student(student_id)));
create policy videos_read on public.videos for select using (
  public.is_teacher() or exists (
    select 1 from public.video_assignments a where a.video_id = videos.id and public.can_view_student(a.student_id)));
create policy video_assign_read on public.video_assignments for select using (public.can_view_student(student_id));
create policy pa_read on public.practice_assignments for select using (
  public.is_teacher() or exists (
    select 1 from public.practice_assignment_students s where s.assignment_id = practice_assignments.id and public.can_view_student(s.student_id)));
create policy pas_read on public.practice_assignment_students for select using (public.can_view_student(student_id));
-- invitations and audit_log get no policies: reachable by the service role only.

-- Private bucket: nothing is public, playback uses short-lived signed URLs issued after an authorization check.
insert into storage.buckets (id, name, public) values ('lesson-videos', 'lesson-videos', false);
