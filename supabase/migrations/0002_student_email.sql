-- The student's own email. A child's account still belongs to the guardian, in guardian_email.
alter table public.students add column if not exists email text;
