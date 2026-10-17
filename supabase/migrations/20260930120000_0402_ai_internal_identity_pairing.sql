-- 0402 — a CRM member and a signed Feishu DM jointly prove an identity binding.
-- The random pairing token is returned once; only its SHA-256 digest is stored.
create table if not exists public.ai_internal_identity_challenges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  provider text not null check (provider='feishu'),
  tenant_key text not null check (char_length(tenant_key) between 1 and 256),
  kind text not null check (kind in ('tenant_owner','member')),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  consumed_at timestamptz,
  consumed_event_id text,
  external_user_id text,
  created_at timestamptz not null default now(),
  foreign key (user_id,organization_id)
    references public.user_organizations(user_id,organization_id) on delete cascade,
  constraint ai_internal_identity_challenges_consumed_shape check (
    (consumed_at is null and consumed_event_id is null and external_user_id is null)
    or (consumed_at is not null and char_length(consumed_event_id) between 1 and 256
      and char_length(external_user_id) between 1 and 256)
  )
);
create index if not exists ai_internal_identity_challenges_user_idx
  on public.ai_internal_identity_challenges(organization_id,user_id,created_at desc);
create unique index if not exists ai_internal_identity_challenges_event_uidx
  on public.ai_internal_identity_challenges(provider,tenant_key,consumed_event_id)
  where consumed_event_id is not null;
alter table public.ai_internal_identity_challenges enable row level security;
revoke all on public.ai_internal_identity_challenges from public,anon,authenticated;
grant select,insert,update,delete on public.ai_internal_identity_challenges to service_role;
notify pgrst, 'reload schema';
