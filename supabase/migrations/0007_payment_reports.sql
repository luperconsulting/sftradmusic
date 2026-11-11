-- NOT APPLIED. Review, then apply it yourself after 0006_portal_v1.sql. Do not let a tool run this against the
-- shared project.
--
-- Manual "pay with Zelle" (report-then-confirm). Zelle has no links, API or webhooks, so:
--   1. the payer sends money in their own banking app and reports it here ("I've sent it");
--   2. the teacher confirms it (a payment row is recorded) or marks it not received.
-- A report never marks an invoice paid by itself.
-- Payment methods are free text (lowercase words) so Venmo or anything else can be added without a schema change.

-- ---- generic payment methods --------------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.payments'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%method%'
  loop
    execute format('alter table public.payments drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.payments add constraint payments_method_check check (method ~ '^[a-z][a-z_]{1,31}$');

-- ---- Zelle QR image (optional) ------------------------------------------------------------------------------
-- The recipient lives in studio_settings.zelle_recipient (0006). The QR is stored inline as a small image data URL,
-- so it is served only by the API to signed-in payers linked to an invoice (no public bucket).
alter table public.studio_settings
  add column if not exists zelle_qr_data_url text
    check (zelle_qr_data_url is null or (zelle_qr_data_url ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' and length(zelle_qr_data_url) <= 300000));

-- ---- payment reports ----------------------------------------------------------------------------------------
create table public.payment_reports (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  reported_by_account_id uuid not null references public.accounts (id) on delete restrict,
  method text not null default 'zelle' check (method ~ '^[a-z][a-z_]{1,31}$'),
  -- What the payer says they sent. Null means "the amount due".
  amount_cents integer check (amount_cents is null or amount_cents > 0),
  note text not null default '' check (length(note) <= 500),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'not_received')),
  reviewed_by_account_id uuid references public.accounts (id) on delete set null,
  reviewed_at timestamptz,
  payment_id uuid references public.payments (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((status = 'pending') = (reviewed_at is null))
);
create index payment_reports_invoice_idx on public.payment_reports (invoice_id, created_at desc);
create index payment_reports_student_idx on public.payment_reports (student_id) where status = 'pending';
-- One open report per invoice at a time.
create unique index payment_reports_one_pending on public.payment_reports (invoice_id) where status = 'pending';

-- ---- row level security -------------------------------------------------------------------------------------
alter table public.payment_reports enable row level security;

-- Payers see reports for students they can pay for; teachers see their own students' reports.
create policy payment_reports_read on public.payment_reports for select using (public.can_see_student_billing(student_id));

-- A payer may file a pending report only for an issued, unpaid invoice of a student they can pay for, as themself.
-- Teachers review through the API (service role); there are no update or delete policies.
create policy payment_reports_insert on public.payment_reports for insert with check (
  status = 'pending'
  and reviewed_at is null and reviewed_by_account_id is null and payment_id is null
  and reported_by_account_id = public.current_account_id()
  and exists (
    select 1 from public.invoices i
     where i.id = payment_reports.invoice_id
       and i.student_id = payment_reports.student_id
       and i.status in ('sent', 'partially_paid')
       and i.amount_paid_cents < i.total_cents)
  and (
    exists (select 1 from public.account_students l where l.account_id = public.current_account_id() and l.student_id = payment_reports.student_id and l.can_pay)
    or exists (select 1 from public.students s join public.billing_contacts b on b.id = s.payer_id
                where s.id = payment_reports.student_id and b.account_id = public.current_account_id())));

revoke all on table public.payment_reports from anon, authenticated, public;
grant select on table public.payment_reports to authenticated;
grant insert (invoice_id, student_id, reported_by_account_id, method, amount_cents, note) on table public.payment_reports to authenticated;
