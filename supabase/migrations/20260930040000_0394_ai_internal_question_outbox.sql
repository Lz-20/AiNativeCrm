-- 0394 — manager-authorized questions leave through a durable encrypted
-- outbox. Feishu's send UUID deduplicates for one hour; automatic delivery
-- expires sooner and never retries an uncertain result after that window.
alter table public.job_queue drop constraint if exists job_queue_kind_check;
alter table public.job_queue add constraint job_queue_kind_check check (kind in (
  'inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn','operator_turn',
  'transactional_delivery','approved_reply','workbench_start','workbench_resume',
  'internal_im_event','internal_im_question'
));

create table if not exists public.ai_internal_question_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  mission_id uuid not null,
  requester_user_id uuid not null,
  recipient_user_id uuid not null,
  provider text not null default 'feishu' check (provider='feishu'),
  tenant_key text not null check (char_length(tenant_key) between 1 and 256),
  recipient_open_id text not null check (char_length(recipient_open_id) between 1 and 256),
  request_key uuid not null,
  question_digest text not null check (question_digest ~ '^[a-f0-9]{64}$'),
  question_ciphertext bytea,
  question_iv bytea,
  question_tag bytea,
  status text not null default 'pending'
    check (status in ('pending','sent','needs_review','expired')),
  message_id text check (message_id is null or char_length(message_id) between 1 and 256),
  chat_id text check (chat_id is null or char_length(chat_id) between 1 and 256),
  failure_code text check (failure_code is null or char_length(failure_code) <= 64),
  created_at timestamptz not null default now(),
  send_deadline_at timestamptz not null default (now() + interval '45 minutes'),
  payload_expires_at timestamptz not null default (now() + interval '7 days'),
  sent_at timestamptz,
  unique (organization_id, mission_id, request_key),
  unique (provider, tenant_key, message_id),
  foreign key (mission_id, organization_id)
    references public.ai_missions(id, organization_id) on delete cascade,
  foreign key (requester_user_id, organization_id)
    references public.user_organizations(user_id, organization_id),
  foreign key (recipient_user_id, organization_id)
    references public.user_organizations(user_id, organization_id),
  foreign key (organization_id, provider, tenant_key)
    references public.ai_internal_platform_tenants(organization_id, provider, tenant_key),
  check (
    (question_ciphertext is null and question_iv is null and question_tag is null)
    or (question_ciphertext is not null and octet_length(question_iv)=12
      and octet_length(question_tag)=16)
  ),
  check (status <> 'pending' or question_ciphertext is not null),
  check (status <> 'sent' or (message_id is not null and chat_id is not null and sent_at is not null))
);
create index if not exists ai_internal_question_outbox_due_idx
  on public.ai_internal_question_outbox(payload_expires_at)
  where question_ciphertext is not null;
alter table public.ai_internal_question_outbox enable row level security;
revoke all on public.ai_internal_question_outbox from public, anon, authenticated;
grant all on public.ai_internal_question_outbox to service_role;
notify pgrst, 'reload schema';
