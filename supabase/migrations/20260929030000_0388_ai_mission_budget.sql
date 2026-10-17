-- 0388 — a Mission has a cumulative, cross-Run model budget.
alter table public.ai_missions
  add column if not exists max_total_tokens integer not null default 72000
    check (max_total_tokens between 1000 and 1000000),
  add column if not exists max_total_cost_cents numeric(12,4) not null default 200
    check (max_total_cost_cents > 0 and max_total_cost_cents <= 100000);

notify pgrst, 'reload schema';
