-- Immutable observed Wiki content/provenance. Source withdrawal is checked on every read.
create unique index if not exists ai_knowledge_sources_org_id_wiki_uidx on public.ai_knowledge_sources(organization_id,id);
create table if not exists public.ai_wiki_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid not null,
  manifest_hash text not null check(manifest_hash ~ '^[a-f0-9]{64}$'),
  manifest jsonb not null,
  content text not null check(char_length(content)<=100000),
  created_at timestamptz not null default now(),
  foreign key(organization_id,source_id) references public.ai_knowledge_sources(organization_id,id) on delete cascade,
  unique(organization_id,source_id,manifest_hash)
);
alter table public.ai_wiki_evidence enable row level security;
revoke all on public.ai_wiki_evidence from public,anon,authenticated,service_role;
grant select,insert on public.ai_wiki_evidence to service_role;
notify pgrst,'reload schema';
