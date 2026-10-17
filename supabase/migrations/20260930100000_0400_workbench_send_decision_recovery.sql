-- 0400 — a customer-send decision and its Pi continuation have separate
-- transactions. This private receipt makes post-approval recovery idempotent.
create table if not exists public.ai_workbench_send_decision_receipts (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  proposal_id uuid primary key references public.ai_agent_action_proposals(id) on delete cascade,
  run_id uuid not null references public.ai_workbench_runs(id) on delete cascade,
  decision text not null check (decision in ('approve','reject')),
  outcome text not null check (outcome in ('queued','awaiting_confirmation','partial')),
  resume_job_id uuid references public.job_queue(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint ai_workbench_send_decision_receipts_resume_shape_check
    check ((outcome='queued') = (resume_job_id is not null))
);
create index if not exists ai_workbench_send_decision_receipts_org_run_idx
  on public.ai_workbench_send_decision_receipts(organization_id,run_id);
alter table public.ai_workbench_send_decision_receipts enable row level security;
revoke all on public.ai_workbench_send_decision_receipts from public,anon,authenticated;
grant select,insert on public.ai_workbench_send_decision_receipts to service_role;
notify pgrst, 'reload schema';
