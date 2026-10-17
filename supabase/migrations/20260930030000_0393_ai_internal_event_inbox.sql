-- 0393 — A signed Feishu callback commits a bounded encrypted fact and queue
-- job before acknowledgment. The worker owns Mission continuation.
alter table public.job_queue drop constraint if exists job_queue_kind_check;
alter table public.job_queue add constraint job_queue_kind_check check (kind in (
  'inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn','operator_turn',
  'transactional_delivery','approved_reply','workbench_start','workbench_resume',
  'internal_im_event'
));

create table if not exists public.ai_internal_event_inbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  mission_id uuid not null,
  provider text not null check (provider='feishu'),
  tenant_key text not null check (char_length(tenant_key) between 1 and 256),
  event_id text not null check (char_length(event_id) between 1 and 256),
  event_digest text not null check (event_digest ~ '^[a-f0-9]{64}$'),
  external_user_id text not null check (char_length(external_user_id) between 1 and 256),
  chat_id text not null check (char_length(chat_id) between 1 and 256),
  root_message_id text not null check (char_length(root_message_id) between 1 and 256),
  message_id text not null check (char_length(message_id) between 1 and 256),
  content_ciphertext bytea,
  content_iv bytea,
  content_tag bytea,
  status text not null default 'pending'
    check (status in ('pending','processed','needs_review','expired')),
  processed_run_id uuid,
  failure_code text check (failure_code is null or char_length(failure_code) <= 64),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  processed_at timestamptz,
  unique (provider, tenant_key, event_id),
  foreign key (mission_id, organization_id)
    references public.ai_missions(id, organization_id) on delete cascade,
  foreign key (organization_id, mission_id, processed_run_id)
    references public.ai_workbench_runs(organization_id, mission_id, id) on delete cascade,
  check (
    (content_ciphertext is null and content_iv is null and content_tag is null)
    or (content_ciphertext is not null and octet_length(content_iv)=12
      and octet_length(content_tag)=16)
  ),
  check (status <> 'pending' or content_ciphertext is not null),
  check (status <> 'processed' or processed_run_id is not null)
);
create index if not exists ai_internal_event_inbox_due_idx
  on public.ai_internal_event_inbox(expires_at)
  where content_ciphertext is not null;
alter table public.ai_internal_event_inbox enable row level security;
revoke all on public.ai_internal_event_inbox from public, anon, authenticated;
grant all on public.ai_internal_event_inbox to service_role;
notify pgrst, 'reload schema';
