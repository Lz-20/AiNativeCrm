-- 0397 — distinguish a manager's trusted direction from unverified internal facts.
-- The instruction body is task memory on the manager-scoped Mission and Run;
-- the idempotency ledger holds only a digest and replacement Run identity.
alter table public.ai_mission_internal_inputs
  add column if not exists kind text not null default 'internal_fact';
alter table public.ai_mission_internal_inputs
  drop constraint if exists ai_mission_internal_inputs_kind_check;
alter table public.ai_mission_internal_inputs
  add constraint ai_mission_internal_inputs_kind_check
  check (kind in ('internal_fact', 'manager_direction'));

-- Task memory, not a second source of CRM facts. Manager-only Mission reads
-- may show it; every new Run still has to re-read current CRM state.
alter table public.ai_missions
  add column if not exists current_direction text,
  add column if not exists direction_revision bigint not null default 0;
alter table public.ai_missions
  drop constraint if exists ai_missions_current_direction_check;
alter table public.ai_missions
  add constraint ai_missions_current_direction_check
  check (current_direction is null or char_length(current_direction) between 5 and 2000);

notify pgrst, 'reload schema';
