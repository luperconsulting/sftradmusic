-- NOT APPLIED. Review, then apply it yourself. Do not let a tool run this against the shared project.
--
-- Makes Supabase the source of truth for core portal data, so GoHighLevel is no longer required:
--   * students no longer need a GoHighLevel contact or billing contact id
--   * guardians, student-guardian links and billing contacts (payers) live here
--   * lessons and bookings live here, with cancellation and a reschedule link
--   * invoices, invoice lines and payment history live here
--
-- The API writes with the service role. RLS is the second line of defense if a browser key is ever used
-- directly: students and guardians see only records linked to their own account, and a teacher sees only
-- their own students. There are no insert, update or delete policies, so every write goes through the API.
-- Nothing here sends email or SMS, charges a card, or talks to Google Calendar or GoHighLevel.

-- ---- students: GoHighLevel ids become optional legacy references --------------------------------------------
alter table public.students alter column ghl_contact_id drop not null;
alter table public.students alter column billing_contact_id drop not null;
-- The teacher who owns this student. Existing students go to the studio's first active teacher.
alter table public.students add column if not exists teacher_account_id uuid references public.accounts (id) on delete set null;
update public.students
   set teacher_account_id = (select id from public.accounts where role = 'teacher' and status = 'active' order by created_at limit 1)
 where teacher_account_id is null;
create index if not exists students_teacher_idx on public.students (teacher_account_id);
create index if not exists students_email_idx on public.students (lower(email));

-- ---- guardians ----------------------------------------------------------------------------------------------
create table public.guardians (
  id uuid primary key default gen_random_uuid(),
  -- Set once the guardian has a portal login. Null until they accept an invitation.
  account_id uuid references public.accounts (id) on delete set null,
  full_name text not null,
  email text not null,
  phone text,
  created_at timestamptz not null default now()
);
create unique index guardians_email_key on public.guardians (lower(email));
create index guardians_account_idx on public.guardians (account_id);

create table public.student_guardians (
  student_id uuid not null references public.students (id) on delete cascade,
  guardian_id uuid not null references public.guardians (id) on delete cascade,
  relationship text not null default 'guardian',
  created_at timestamptz not null default now(),
  primary key (student_id, guardian_id)
);
create index student_guardians_guardian_idx on public.student_guardians (guardian_id);

-- ---- billing contacts (the payer for a student) -------------------------------------------------------------
create table public.billing_contacts (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text,
  -- Exactly one of these is normally set: a guardian pays for a child, an adult pays for themself.
  guardian_id uuid references public.guardians (id) on delete set null,
  account_id uuid references public.accounts (id) on delete set null,
  -- Kept only so old GoHighLevel invoices can be matched during migration. Nothing reads it at runtime.
  legacy_ghl_contact_id text,
  created_at timestamptz not null default now()
);
create index billing_contacts_guardian_idx on public.billing_contacts (guardian_id);
create index billing_contacts_account_idx on public.billing_contacts (account_id);

alter table public.students add column if not exists payer_id uuid references public.billing_contacts (id) on delete set null;
create index if not exists students_payer_idx on public.students (payer_id);

-- ---- lessons and bookings -----------------------------------------------------------------------------------
create table public.lessons (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  teacher_account_id uuid references public.accounts (id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location_kind text not null default 'in_person' check (location_kind in ('in_person', 'zoom')),
  location text not null default '',
  zoom_url text,
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'cancelled', 'rescheduled', 'no_show')),
  cancelled_at timestamptz,
  cancelled_by_account_id uuid references public.accounts (id) on delete set null,
  cancellation_reason text,
  -- The lesson this one replaced. The replaced lesson gets status 'rescheduled'.
  rescheduled_from_id uuid references public.lessons (id) on delete set null,
  created_by_account_id uuid references public.accounts (id) on delete set null,
  legacy_ghl_appointment_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index lessons_student_start_idx on public.lessons (student_id, starts_at);
create index lessons_teacher_start_idx on public.lessons (teacher_account_id, starts_at);
create unique index lessons_rescheduled_from_key on public.lessons (rescheduled_from_id) where rescheduled_from_id is not null;

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.lessons (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  booked_by_account_id uuid references public.accounts (id) on delete set null,
  source text not null default 'teacher' check (source in ('teacher', 'portal', 'import')),
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  created_at timestamptz not null default now()
);
create index bookings_student_idx on public.bookings (student_id, created_at desc);
create index bookings_lesson_idx on public.bookings (lesson_id);

-- ---- billing ------------------------------------------------------------------------------------------------
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity (start with 1001) unique,
  student_id uuid not null references public.students (id) on delete restrict,
  payer_id uuid references public.billing_contacts (id) on delete set null,
  title text not null default '',
  currency text not null default 'USD',
  total_cents integer not null check (total_cents >= 0),
  amount_paid_cents integer not null default 0 check (amount_paid_cents >= 0),
  amount_due_cents integer generated always as (greatest(total_cents - amount_paid_cents, 0)) stored,
  status text not null default 'sent' check (status in ('draft', 'sent', 'partially_paid', 'paid', 'void')),
  issue_date date not null default current_date,
  due_date date not null default current_date,
  voided_at timestamptz,
  created_by_account_id uuid references public.accounts (id) on delete set null,
  legacy_ghl_invoice_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index invoices_student_idx on public.invoices (student_id, issue_date desc);
create index invoices_payer_idx on public.invoices (payer_id);

create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  label text not null,
  amount_cents integer not null,
  lesson_id uuid references public.lessons (id) on delete set null,
  position integer not null default 0
);
create index invoice_lines_invoice_idx on public.invoice_lines (invoice_id, position);

-- Payment history. Rows are recorded by the teacher (cash, check, transfer) or imported. The portal does not charge.
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete restrict,
  payer_id uuid references public.billing_contacts (id) on delete set null,
  amount_cents integer not null check (amount_cents > 0),
  method text not null default 'manual' check (method in ('manual', 'cash', 'check', 'card', 'bank_transfer', 'other')),
  status text not null default 'succeeded' check (status in ('pending', 'succeeded', 'failed', 'refunded')),
  paid_at timestamptz not null default now(),
  note text not null default '',
  recorded_by_account_id uuid references public.accounts (id) on delete set null,
  legacy_ghl_transaction_id text unique,
  created_at timestamptz not null default now()
);
create index payments_invoice_idx on public.payments (invoice_id, paid_at);

-- ---- access helpers -----------------------------------------------------------------------------------------
-- Definer functions so policies can read accounts and links without recursing through RLS.
create function public.teaches_student(sid uuid) returns boolean
  language sql stable security definer set search_path = public as
  $$ select exists (
       select 1 from students s join accounts a on a.id = s.teacher_account_id
        where s.id = sid and a.user_id = auth.uid() and a.role = 'teacher' and a.status = 'active') $$;

create function public.is_linked_to_student(sid uuid) returns boolean
  language sql stable security definer set search_path = public as
  $$ select exists (select 1 from account_students where account_id = public.current_account_id() and student_id = sid)
         or exists (select 1 from student_guardians sg join guardians g on g.id = sg.guardian_id
                     where sg.student_id = sid and g.account_id = public.current_account_id()) $$;

create function public.can_see_student_core(sid uuid) returns boolean
  language sql stable security definer set search_path = public as
  $$ select public.teaches_student(sid) or public.is_linked_to_student(sid) $$;

-- Invoices and payments can name the payer, so only accounts allowed to pay for the student see them.
create function public.can_see_student_billing(sid uuid) returns boolean
  language sql stable security definer set search_path = public as
  $$ select public.teaches_student(sid)
         or exists (select 1 from account_students where account_id = public.current_account_id() and student_id = sid and can_pay)
         or exists (select 1 from students s join billing_contacts b on b.id = s.payer_id
                     where s.id = sid and b.account_id = public.current_account_id()) $$;

revoke all on function public.teaches_student(uuid) from public, anon;
revoke all on function public.is_linked_to_student(uuid) from public, anon;
revoke all on function public.can_see_student_core(uuid) from public, anon;
revoke all on function public.can_see_student_billing(uuid) from public, anon;
grant execute on function public.teaches_student(uuid) to authenticated;
grant execute on function public.is_linked_to_student(uuid) to authenticated;
grant execute on function public.can_see_student_core(uuid) to authenticated;
grant execute on function public.can_see_student_billing(uuid) to authenticated;

-- ---- row level security -------------------------------------------------------------------------------------
alter table public.guardians enable row level security;
alter table public.student_guardians enable row level security;
alter table public.billing_contacts enable row level security;
alter table public.lessons enable row level security;
alter table public.bookings enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_lines enable row level security;
alter table public.payments enable row level security;

create policy guardians_read on public.guardians for select using (
  account_id = public.current_account_id()
  or exists (select 1 from public.student_guardians sg where sg.guardian_id = guardians.id and public.teaches_student(sg.student_id)));

create policy student_guardians_read on public.student_guardians for select using (public.can_see_student_core(student_id));

create policy billing_contacts_read on public.billing_contacts for select using (
  account_id = public.current_account_id()
  or exists (select 1 from public.guardians g where g.id = billing_contacts.guardian_id and g.account_id = public.current_account_id())
  or exists (select 1 from public.students s where s.payer_id = billing_contacts.id and public.teaches_student(s.id)));

create policy lessons_read on public.lessons for select using (
  public.can_see_student_core(student_id)
  or teacher_account_id = public.current_account_id());

create policy bookings_read on public.bookings for select using (public.can_see_student_core(student_id));

-- Drafts are the teacher's working copies and stay hidden from families.
create policy invoices_read on public.invoices for select using (
  public.teaches_student(student_id) or (status <> 'draft' and public.can_see_student_billing(student_id)));

create policy invoice_lines_read on public.invoice_lines for select using (
  exists (select 1 from public.invoices i where i.id = invoice_lines.invoice_id
           and (public.teaches_student(i.student_id) or (i.status <> 'draft' and public.can_see_student_billing(i.student_id)))));

create policy payments_read on public.payments for select using (
  exists (select 1 from public.invoices i where i.id = payments.invoice_id and public.can_see_student_billing(i.student_id)));

-- Anonymous keys get nothing. Signed-in users can only select, and only what the policies above allow.
revoke all on table public.guardians, public.student_guardians, public.billing_contacts, public.lessons,
  public.bookings, public.invoices, public.invoice_lines, public.payments from anon, public;
grant select on table public.guardians, public.student_guardians, public.billing_contacts, public.lessons,
  public.bookings, public.invoices, public.invoice_lines, public.payments to authenticated;

-- ---- backfill from the columns students already have ---------------------------------------------------------
-- Guardians for existing children, linked by their email. A guardian with a portal login gets that account.
insert into public.guardians (full_name, email, account_id)
select distinct on (lower(s.guardian_email)) coalesce(nullif(s.guardian_name, ''), s.guardian_email), lower(s.guardian_email),
       (select a.id from public.accounts a where lower(a.email) = lower(s.guardian_email) and a.role = 'guardian' limit 1)
  from public.students s
 where s.is_minor and s.guardian_email is not null and s.guardian_email <> ''
 order by lower(s.guardian_email), s.created_at
on conflict ((lower(email))) do nothing;

insert into public.student_guardians (student_id, guardian_id)
select s.id, g.id from public.students s join public.guardians g on lower(g.email) = lower(s.guardian_email)
 where s.is_minor
on conflict do nothing;

-- One billing contact per guardian, and one per adult student.
insert into public.billing_contacts (full_name, email, guardian_id, account_id)
select g.full_name, g.email, g.id, g.account_id from public.guardians g
 where not exists (select 1 from public.billing_contacts b where b.guardian_id = g.id);

update public.students s set payer_id = b.id
  from public.student_guardians sg join public.billing_contacts b on b.guardian_id = sg.guardian_id
 where s.is_minor and s.payer_id is null and sg.student_id = s.id;

with adults as (
  select s.id as student_id, s.full_name, s.email, s.billing_contact_id,
         (select a.id from public.account_students l join public.accounts a on a.id = l.account_id
           where l.student_id = s.id and a.role = 'student' limit 1) as account_id
    from public.students s where not s.is_minor and s.payer_id is null
), created as (
  insert into public.billing_contacts (full_name, email, account_id, legacy_ghl_contact_id)
  select full_name, lower(email), account_id, billing_contact_id from adults
  returning id, legacy_ghl_contact_id, account_id, full_name, email
)
update public.students s set payer_id = c.id
  from created c
 where not s.is_minor and s.payer_id is null and s.full_name = c.full_name and lower(s.email) is not distinct from c.email;
