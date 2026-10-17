-- Optional services are infrastructure. No deployment or credential is created by this migration.
create table if not exists public.ai_integration_settings (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('mem0','weknora','langfuse')),
  enabled boolean not null default false,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, provider)
);
alter table public.ai_integration_settings enable row level security;
drop policy if exists tenant_isolation_ai_integration_settings_all on public.ai_integration_settings;
create policy tenant_isolation_ai_integration_settings_all on public.ai_integration_settings
  for select to authenticated using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.ai_integration_settings from public, anon, authenticated;
grant select on public.ai_integration_settings to authenticated;
grant select, insert, update, delete on public.ai_integration_settings to service_role;
