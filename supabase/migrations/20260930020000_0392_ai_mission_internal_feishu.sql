-- 0392 — Feishu is an employee input port, never a customer channel or approval.
-- Provisioning is service-role only until tenant installation and account-link
-- proof are implemented. No external identity can authorize itself here.
create table if not exists public.ai_internal_platform_tenants (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider = 'feishu'),
  tenant_key text not null check (char_length(tenant_key) between 1 and 256),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (provider, tenant_key),
  unique (organization_id, provider, tenant_key)
);

create table if not exists public.ai_internal_platform_users (
  organization_id uuid not null,
  provider text not null check (provider = 'feishu'),
  tenant_key text not null,
  external_user_id text not null check (char_length(external_user_id) between 1 and 256),
  user_id uuid not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (provider, tenant_key, external_user_id),
  unique (organization_id, provider, tenant_key, external_user_id),
  foreign key (organization_id, provider, tenant_key)
    references public.ai_internal_platform_tenants(organization_id, provider, tenant_key)
    on delete cascade,
  foreign key (user_id, organization_id)
    references public.user_organizations(user_id, organization_id)
    on delete cascade
);

create table if not exists public.ai_mission_internal_threads (
  organization_id uuid not null,
  mission_id uuid not null,
  provider text not null check (provider = 'feishu'),
  tenant_key text not null,
  chat_id text not null check (char_length(chat_id) between 1 and 256),
  root_message_id text not null check (char_length(root_message_id) between 1 and 256),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (provider, tenant_key, chat_id, root_message_id),
  foreign key (organization_id, provider, tenant_key)
    references public.ai_internal_platform_tenants(organization_id, provider, tenant_key)
    on delete cascade,
  foreign key (mission_id, organization_id)
    references public.ai_missions(id, organization_id) on delete cascade
);
create index if not exists ai_mission_internal_threads_mission_idx
  on public.ai_mission_internal_threads(organization_id, mission_id);

alter table public.ai_mission_internal_inputs
  add column if not exists source_provider text,
  add column if not exists source_tenant_key text,
  add column if not exists source_event_id text;
alter table public.ai_mission_internal_inputs
  drop constraint if exists ai_mission_internal_inputs_source_shape;
alter table public.ai_mission_internal_inputs
  add constraint ai_mission_internal_inputs_source_shape check (
    (source_provider is null and source_tenant_key is null and source_event_id is null)
    or (source_provider = 'feishu'
      and char_length(source_tenant_key) between 1 and 256
      and char_length(source_event_id) between 1 and 256)
  );
create unique index if not exists ai_mission_internal_inputs_source_uidx
  on public.ai_mission_internal_inputs(source_provider, source_tenant_key, source_event_id)
  where source_provider is not null;

alter table public.ai_internal_platform_tenants enable row level security;
alter table public.ai_internal_platform_users enable row level security;
alter table public.ai_mission_internal_threads enable row level security;
revoke all on public.ai_internal_platform_tenants,
  public.ai_internal_platform_users, public.ai_mission_internal_threads
  from public, anon, authenticated;
grant all on public.ai_internal_platform_tenants,
  public.ai_internal_platform_users, public.ai_mission_internal_threads
  to service_role;
notify pgrst, 'reload schema';
