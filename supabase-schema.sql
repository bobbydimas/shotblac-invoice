-- Run this once in Supabase: SQL Editor → New query → Run.
create table if not exists public.invoices (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  invoice_id text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  unique (user_id, invoice_id)
);

create table if not exists public.settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expense_id text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  unique (user_id, expense_id)
);

alter table public.invoices enable row level security;
alter table public.settings enable row level security;
alter table public.expenses enable row level security;

create policy "Users manage their own invoices" on public.invoices
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Users manage their own settings" on public.settings
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Users manage their own expenses" on public.expenses
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
