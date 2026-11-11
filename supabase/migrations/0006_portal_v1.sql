-- NOT APPLIED. Review, then apply it yourself after 0005_core_data.sql. Do not let a tool run this against the
-- shared project.
--
-- Portal v1 on Supabase alone:
--   * studio settings per teacher: hold window, notice windows, Zelle recipient
--   * weekly lesson hours (the base for open times)
--   * 60-minute lessons only, session holds ("pending payment"), weekly series, late cancels
--   * a Postgres exclusion constraint so one teacher can't hold two live lessons at the same time
--   * lesson credits as a ledger (4 added only when a package invoice is marked paid, 1 used per lesson)
--   * package and session invoices with the chosen offline method (Zelle or cash), payment references
--   * referrals: one code per student, $15 off the referred student's first invoice, $25 credit to the referrer
--   * Stripe test-mode idempotency (only used when CARD_PAYMENTS_ENABLED=true)
-- RLS: select-only policies. Students and guardians see their linked records, teachers their own students.

create extension if not exists btree_gist with schema extensions;

-- ---- studio settings ----------------------------------------------------------------------------------------
create table public.studio_settings (
  teacher_account_id uuid primary key references public.accounts (id) on delete cascade,
  hold_window_minutes integer not null default 1440 check (hold_window_minutes between 15 and 10080),
  reschedule_notice_hours integer not null default 24 check (reschedule_notice_hours between 0 and 336),
  cancel_notice_hours integer not null default 24 check (cancel_notice_hours between 0 and 336),
  zelle_recipient text not null default '',
  timezone text not null default 'America/Los_Angeles',
  updated_at timestamptz not null default now()
);

-- Weekly lesson hours in the studio time zone, as minutes after local midnight.
create table public.lesson_hours (
  id uuid primary key default gen_random_uuid(),
  teacher_account_id uuid not null references public.accounts (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_minute integer not null check (start_minute between 0 and 1439),
  end_minute integer not null check (end_minute between 1 and 1440),
  created_at timestamptz not null default now(),
  check (end_minute > start_minute),
  unique (teacher_account_id, weekday, start_minute)
);

-- ---- lessons: holds, series, 60 minutes, no double booking ---------------------------------------------------
create table public.lesson_series (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  teacher_account_id uuid references public.accounts (id) on delete set null,
  created_by_account_id uuid references public.accounts (id) on delete set null,
  status text not null default 'active' check (status in ('active', 'ended')),
  created_at timestamptz not null default now()
);

-- Replace 0005's status checks (names are generated, so find them by definition).
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.lessons'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%status%'
  loop
    execute format('alter table public.lessons drop constraint %I', c.conname);
  end loop;
end $$;

-- Every lesson belongs to a teacher, so the exclusion constraint below always applies. The server always sets it.
alter table public.lessons alter column teacher_account_id set not null;

alter table public.lessons
  add column if not exists hold_expires_at timestamptz,
  add column if not exists invoice_id uuid references public.invoices (id) on delete set null,
  add column if not exists series_id uuid references public.lesson_series (id) on delete set null,
  add column if not exists late_cancel boolean not null default false,
  add constraint lessons_status_check
    check (status in ('scheduled', 'pending_payment', 'completed', 'cancelled', 'rescheduled', 'released', 'no_show')),
  add constraint lessons_cancelled_at_check check ((status = 'cancelled') = (cancelled_at is not null)),
  add constraint lessons_hold_check check ((status = 'pending_payment') = (hold_expires_at is not null)),
  add constraint lessons_sixty_minutes check (ends_at = starts_at + interval '60 minutes'),
  -- Live lessons (confirmed or held) for one teacher may not overlap.
  add constraint lessons_no_overlap exclude using gist (
    teacher_account_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('scheduled', 'pending_payment'));

create index if not exists lessons_hold_idx on public.lessons (hold_expires_at) where status = 'pending_payment';
create index if not exists lessons_invoice_idx on public.lessons (invoice_id);

alter table public.lesson_notes add column if not exists lesson_id uuid references public.lessons (id) on delete set null;

-- ---- invoices: kind, chosen method, Stripe ------------------------------------------------------------------
alter table public.invoices
  add column if not exists kind text not null default 'manual' check (kind in ('package', 'session', 'manual')),
  add column if not exists payment_method_choice text check (payment_method_choice in ('zelle', 'cash', 'card')),
  add column if not exists package_lessons integer not null default 0 check (package_lessons in (0, 4)),
  add column if not exists stripe_checkout_session_id text unique;

do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.payments'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%method%'
  loop
    execute format('alter table public.payments drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.payments
  add column if not exists reference text not null default '',
  add constraint payments_method_check check (method in ('zelle', 'cash', 'card', 'manual', 'check', 'bank_transfer', 'other'));

-- A paid invoice adds its credits once. Each booked lesson uses one credit once.
create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  delta integer not null check (delta <> 0),
  reason text not null check (reason in ('package_paid', 'lesson_booked', 'lesson_refund', 'adjustment')),
  invoice_id uuid references public.invoices (id) on delete set null,
  lesson_id uuid references public.lessons (id) on delete set null,
  created_by_account_id uuid references public.accounts (id) on delete set null,
  created_at timestamptz not null default now()
);
create index credit_ledger_student_idx on public.credit_ledger (student_id);
create unique index credit_ledger_package_once on public.credit_ledger (invoice_id) where reason = 'package_paid';
create unique index credit_ledger_lesson_once on public.credit_ledger (lesson_id, reason) where reason in ('lesson_booked', 'lesson_refund');

-- Stripe webhook events already handled (test mode only).
create table public.stripe_events (
  id text primary key,
  type text not null,
  invoice_id uuid references public.invoices (id) on delete set null,
  processed_at timestamptz not null default now()
);

-- ---- referrals ----------------------------------------------------------------------------------------------
create table public.referral_codes (
  student_id uuid primary key references public.students (id) on delete cascade,
  code text not null unique check (code ~ '^SFTM-[A-Z0-9]{8}$'),
  created_at timestamptz not null default now()
);

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_student_id uuid not null references public.students (id) on delete cascade,
  referred_student_id uuid not null unique references public.students (id) on delete cascade,
  code text not null,
  status text not null default 'pending' check (status in ('pending', 'completed')),
  discount_cents integer not null default 1500,
  discount_invoice_id uuid references public.invoices (id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check (referrer_student_id <> referred_student_id)
);
create index referrals_referrer_idx on public.referrals (referrer_student_id);

-- One $25 credit per completed referral, used on the referrer's next invoice exactly once.
create table public.referral_credits (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null unique references public.referrals (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  amount_cents integer not null default 2500 check (amount_cents > 0),
  used_invoice_id uuid references public.invoices (id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index referral_credits_student_idx on public.referral_credits (student_id) where used_invoice_id is null;

-- ---- row level security -------------------------------------------------------------------------------------
alter table public.studio_settings enable row level security;
alter table public.lesson_hours enable row level security;
alter table public.lesson_series enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.stripe_events enable row level security;
alter table public.referral_codes enable row level security;
alter table public.referrals enable row level security;
alter table public.referral_credits enable row level security;

-- A teacher reads their own settings and hours. A family reads them only for a teacher of a student linked to them
-- (they need the Zelle recipient and notice rules).
create policy studio_settings_read on public.studio_settings for select using (
  teacher_account_id = public.current_account_id()
  or exists (select 1 from public.students s where s.teacher_account_id = studio_settings.teacher_account_id and public.is_linked_to_student(s.id)));
create policy lesson_hours_read on public.lesson_hours for select using (
  teacher_account_id = public.current_account_id()
  or exists (select 1 from public.students s where s.teacher_account_id = lesson_hours.teacher_account_id and public.is_linked_to_student(s.id)));
create policy lesson_series_read on public.lesson_series for select using (public.can_see_student_core(student_id));
create policy credit_ledger_read on public.credit_ledger for select using (public.can_see_student_core(student_id));
create policy referral_codes_read on public.referral_codes for select using (public.can_see_student_core(student_id));
-- The referrer sees their referrals (pending and completed); the referred student sees their own row.
create policy referrals_read on public.referrals for select using (
  public.can_see_student_core(referrer_student_id) or public.can_see_student_core(referred_student_id));
create policy referral_credits_read on public.referral_credits for select using (public.can_see_student_billing(student_id));
-- stripe_events: no policy, service role only.

revoke all on table public.studio_settings, public.lesson_hours, public.lesson_series, public.credit_ledger,
  public.stripe_events, public.referral_codes, public.referrals, public.referral_credits from anon, authenticated, public;
grant select on table public.studio_settings, public.lesson_hours, public.lesson_series, public.credit_ledger,
  public.referral_codes, public.referrals, public.referral_credits to authenticated;

-- ---- defaults for the existing teacher ----------------------------------------------------------------------
insert into public.studio_settings (teacher_account_id)
select id from public.accounts where role = 'teacher' and status = 'active'
on conflict do nothing;
