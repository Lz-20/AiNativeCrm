-- Additive RAG storage. Never ALTER ai_chunks.embedding or rewrite old vectors.
create table if not exists public.ai_embedding_configurations (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('siliconflow','bailian','openai')),
  base_url text not null,
  model text not null,
  dimensions integer not null check (dimensions in (1024,1536)),
  model_revision text not null,
  fingerprint text not null check (fingerprint ~ '^embedding:v1:[a-f0-9]{64}$'),
  credential_id uuid references public.ai_provider_credentials(id) on delete set null,
  enabled boolean not null default false,
  version uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now(),
  constraint embedding_public_endpoint check (
    (provider='siliconflow' and base_url='https://api.siliconflow.cn/v1' and model in ('BAAI/bge-m3','Pro/BAAI/bge-m3') and dimensions=1024)
    or (provider='bailian' and base_url in ('https://dashscope.aliyuncs.com/compatible-mode/v1','https://dashscope-intl.aliyuncs.com/compatible-mode/v1') and model='text-embedding-v4')
    or (provider='openai' and base_url='https://api.openai.com/v1' and model='text-embedding-3-small')
  )
);
alter table public.ai_embedding_configurations enable row level security;
drop policy if exists embedding_configuration_read on public.ai_embedding_configurations;
create policy embedding_configuration_read on public.ai_embedding_configurations for select to authenticated
  using (public.fn_role_at_least(organization_id,'manager'));
revoke all on public.ai_embedding_configurations from public, anon, authenticated;
grant select on public.ai_embedding_configurations to authenticated;
grant all on public.ai_embedding_configurations to service_role;

alter table public.ai_knowledge_versions add column if not exists embedding_profile jsonb;
comment on column public.ai_knowledge_versions.embedding_profile is
  'Immutable non-secret provider/endpoint/model/dimensions/revision snapshot. Legacy vectors stay in ai_chunks.';

create table if not exists public.ai_embedding_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  knowledge_source_id uuid not null references public.ai_knowledge_sources(id) on delete cascade,
  kb_version_id uuid not null references public.ai_knowledge_versions(id) on delete cascade,
  position integer not null,
  content text not null,
  content_hash text not null,
  token_count integer not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding public.vector not null,
  embedding_dims integer not null check (embedding_dims in (1024,1536)),
  embedding_fingerprint text not null,
  created_at timestamptz not null default now(),
  unique (knowledge_source_id,kb_version_id,position),
  check (public.vector_dims(embedding)=embedding_dims and public.vector_norm(embedding)>0)
);
alter table public.ai_embedding_chunks enable row level security;
drop policy if exists embedding_chunks_read on public.ai_embedding_chunks;
create policy embedding_chunks_read on public.ai_embedding_chunks for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.ai_embedding_chunks from public, anon, authenticated;
grant select on public.ai_embedding_chunks to authenticated;
grant all on public.ai_embedding_chunks to service_role;
create index if not exists embedding_chunks_tenant_version on public.ai_embedding_chunks(organization_id,kb_version_id,embedding_fingerprint);
create index if not exists embedding_chunks_1024_cosine on public.ai_embedding_chunks
  using hnsw ((embedding::public.vector(1024)) public.vector_cosine_ops) where embedding_dims=1024;
create index if not exists embedding_chunks_1536_cosine on public.ai_embedding_chunks
  using hnsw ((embedding::public.vector(1536)) public.vector_cosine_ops) where embedding_dims=1536;

create or replace function public.fn_embedding_configuration_guard() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
  if new.credential_id is not null and not exists (
    select 1 from public.ai_provider_credentials c where c.id=new.credential_id
      and c.organization_id=new.organization_id and c.provider=new.provider and c.is_active
  ) then raise exception 'embedding_credential_provider_or_tenant_mismatch'; end if;
  return new;
end $$;
drop trigger if exists embedding_configuration_guard on public.ai_embedding_configurations;
create trigger embedding_configuration_guard before insert or update on public.ai_embedding_configurations
for each row execute function public.fn_embedding_configuration_guard();

create or replace function public.fn_embedding_chunk_guard() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
  if not exists (select 1 from public.ai_knowledge_versions v
    join public.ai_knowledge_sources s on s.id=v.knowledge_source_id and s.organization_id=v.organization_id
    where v.id=new.kb_version_id and v.organization_id=new.organization_id
      and s.id=new.knowledge_source_id and v.status='building'
      and v.embedding_model=new.embedding_fingerprint and v.embedding_dims=new.embedding_dims
      and v.embedding_profile->>'fingerprint'=new.embedding_fingerprint
      and (v.embedding_profile->>'dimensions')::integer=new.embedding_dims)
  then raise exception 'embedding_chunk_profile_or_tenant_mismatch'; end if;
  return new;
end $$;
drop trigger if exists embedding_chunk_guard on public.ai_embedding_chunks;
create trigger embedding_chunk_guard before insert or update on public.ai_embedding_chunks
for each row execute function public.fn_embedding_chunk_guard();

create or replace function public.fn_embedding_version_guard() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
  if (old.embedding_profile is not null or new.embedding_profile is not null) and old.status is distinct from 'building' and
    (new.embedding_profile is distinct from old.embedding_profile or new.embedding_model is distinct from old.embedding_model
      or new.embedding_dims is distinct from old.embedding_dims or new.organization_id is distinct from old.organization_id
      or new.knowledge_source_id is distinct from old.knowledge_source_id)
  then raise exception 'embedding_version_identity_immutable'; end if;
  return new;
end $$;
drop trigger if exists embedding_version_guard on public.ai_knowledge_versions;
create trigger embedding_version_guard before update on public.ai_knowledge_versions
for each row execute function public.fn_embedding_version_guard();

-- Atomic pointer swap: config edits or incomplete inserts cannot retire the old index.
create or replace function public.fn_activate_embedding_version(p_organization_id uuid,p_source_id uuid,p_version_id uuid,p_fingerprint text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare expected integer;
begin
  if auth.uid() is not null and not public.fn_role_at_least(p_organization_id,'admin')
  then raise exception 'caller_not_authorized_for_org'; end if;
  perform 1 from public.ai_embedding_configurations where organization_id=p_organization_id
    and fingerprint=p_fingerprint and enabled for share;
  if not found then raise exception 'embedding_configuration_changed'; end if;
  perform 1 from public.ai_knowledge_sources where id=p_source_id and organization_id=p_organization_id and is_active for update;
  if not found then raise exception 'embedding_source_unavailable'; end if;
  select total_chunks into expected from public.ai_knowledge_versions where id=p_version_id
    and organization_id=p_organization_id and knowledge_source_id=p_source_id and status='ready'
    and embedding_model=p_fingerprint and embedding_profile->>'fingerprint'=p_fingerprint;
  if expected is null or expected<=0 or expected<>(select count(*) from public.ai_embedding_chunks
    where organization_id=p_organization_id and knowledge_source_id=p_source_id and kb_version_id=p_version_id
      and embedding_fingerprint=p_fingerprint)
  then raise exception 'embedding_index_incomplete'; end if;
  update public.ai_knowledge_versions set is_active=false where organization_id=p_organization_id
    and knowledge_source_id=p_source_id and id<>p_version_id and is_active;
  update public.ai_knowledge_versions set is_active=true,activated_at=now() where id=p_version_id and organization_id=p_organization_id;
  update public.ai_knowledge_sources set active_kb_version_id=p_version_id where id=p_source_id and organization_id=p_organization_id;
end $$;
revoke execute on function public.fn_activate_embedding_version(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_activate_embedding_version(uuid,uuid,uuid,text) to service_role;

revoke execute on function public.fn_embedding_configuration_guard() from public,anon,authenticated;
revoke execute on function public.fn_embedding_chunk_guard() from public,anon,authenticated;
revoke execute on function public.fn_embedding_version_guard() from public,anon,authenticated;

create or replace function public.fn_search_knowledge_profile(
 p_organization_id uuid,p_source_ids uuid[],p_embedding public.vector,p_fingerprint text,p_dimensions integer,
 p_k integer default 5,p_threshold real default 0.4
) returns table(chunk_id uuid,knowledge_source_id uuid,source_name text,content text,similarity real,metadata jsonb,
 index_version_id uuid,position integer,content_hash text)
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
 if auth.uid() is not null and not public.fn_role_at_least(p_organization_id,'viewer')
 then raise exception 'caller_not_authorized_for_org'; end if;
 if p_dimensions not in (1024,1536) or public.vector_dims(p_embedding)<>p_dimensions or public.vector_norm(p_embedding)<=0
 then raise exception 'embedding_vector_invalid'; end if;
 if not exists(select 1 from public.ai_embedding_configurations cfg where cfg.organization_id=p_organization_id
   and cfg.enabled and cfg.fingerprint=p_fingerprint and cfg.dimensions=p_dimensions)
 then raise exception 'embedding_configuration_changed'; end if;
 if p_dimensions=1024 then
 return query select c.id,c.knowledge_source_id,s.name,c.content,
 (1-(c.embedding::public.vector(1024) OPERATOR(public.<=>) p_embedding::public.vector(1024)))::real,
 c.metadata,c.kb_version_id,c.position,c.content_hash
 from public.ai_embedding_chunks c
 join public.ai_knowledge_sources s on s.id=c.knowledge_source_id and s.organization_id=c.organization_id
 join public.ai_knowledge_versions v on v.id=c.kb_version_id and v.organization_id=c.organization_id
 where c.organization_id=p_organization_id and s.id=any(p_source_ids) and s.is_active and s.status='ready'
   and s.active_kb_version_id=c.kb_version_id and v.status='ready' and v.is_active
   and v.embedding_model=p_fingerprint and v.embedding_dims=1024
   and v.embedding_profile->>'fingerprint'=p_fingerprint
   and c.embedding_fingerprint=p_fingerprint and c.embedding_dims=1024
   and (1-(c.embedding::public.vector(1024) OPERATOR(public.<=>) p_embedding::public.vector(1024)))>=p_threshold
 order by c.embedding::public.vector(1024) OPERATOR(public.<=>) p_embedding::public.vector(1024)
 limit least(greatest(p_k,0),100);
 return;
 end if;
 if p_dimensions=1536 then
 return query select c.id,c.knowledge_source_id,s.name,c.content,
 (1-(c.embedding::public.vector(1536) OPERATOR(public.<=>) p_embedding::public.vector(1536)))::real,
 c.metadata,c.kb_version_id,c.position,c.content_hash
 from public.ai_embedding_chunks c
 join public.ai_knowledge_sources s on s.id=c.knowledge_source_id and s.organization_id=c.organization_id
 join public.ai_knowledge_versions v on v.id=c.kb_version_id and v.organization_id=c.organization_id
 where c.organization_id=p_organization_id and s.id=any(p_source_ids) and s.is_active and s.status='ready'
   and s.active_kb_version_id=c.kb_version_id and v.status='ready' and v.is_active
   and v.embedding_model=p_fingerprint and v.embedding_dims=1536
   and v.embedding_profile->>'fingerprint'=p_fingerprint
   and c.embedding_fingerprint=p_fingerprint and c.embedding_dims=1536
   and (1-(c.embedding::public.vector(1536) OPERATOR(public.<=>) p_embedding::public.vector(1536)))>=p_threshold
 order by c.embedding::public.vector(1536) OPERATOR(public.<=>) p_embedding::public.vector(1536)
 limit least(greatest(p_k,0),100);
 return;
 end if;
end $$;
revoke execute on function public.fn_search_knowledge_profile(uuid,uuid[],public.vector,text,integer,integer,real) from public,anon;
grant execute on function public.fn_search_knowledge_profile(uuid,uuid[],public.vector,text,integer,integer,real) to authenticated,service_role;

-- Unknown provenance must not silently join a known vector space.
create or replace function public.fn_buscar_trechos_das_fontes(
  p_organization_id uuid,
  p_source_ids uuid[],
  p_embedding public.vector,
  p_k integer default 5,
  p_threshold real default 0.40,
  p_embedding_model text default null
) returns table(
  chunk_id uuid,
  knowledge_source_id uuid,
  source_name text,
  content text,
  similarity real,
  metadata jsonb
)
  language plpgsql stable security definer
  set search_path to 'public'
as $$
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'fn_buscar_trechos_das_fontes: caller must be an active member of the organization';
  end if;

  return query
  select
    c.id as chunk_id,
    c.knowledge_source_id,
    s.name as source_name,
    c.content,
    (1 - (c.embedding <=> p_embedding))::real as similarity,
    c.metadata
  from public.ai_chunks c
  join public.ai_knowledge_sources s
    on s.id = c.knowledge_source_id
   and s.organization_id = c.organization_id
  join public.ai_knowledge_versions v
    on v.id = c.kb_version_id and v.organization_id = c.organization_id
  where c.organization_id = p_organization_id
    and s.id = any(p_source_ids)
    and s.is_active
    and s.status = 'ready'
    and c.kb_version_id = s.active_kb_version_id
    and v.embedding_model = coalesce(p_embedding_model,'openai/text-embedding-3-small')
    and v.embedding_dims = public.vector_dims(p_embedding)
    and (1 - (c.embedding <=> p_embedding)) >= p_threshold
  order by c.embedding <=> p_embedding asc
  limit greatest(p_k, 0);
end $$;

create or replace function public.retrieve_top_k_chunks(
  p_organization_id uuid,
  p_kb_version_id uuid,
  p_embedding public.vector,
  p_k integer default 5,
  p_threshold real default 0.40
) returns table (
  chunk_id uuid,
  knowledge_source_id uuid,
  content text,
  similarity real,
  metadata jsonb
)
  language plpgsql stable security definer
  set search_path to 'public'
as $$
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'retrieve_top_k_chunks: caller must be an active member of the organization';
  end if;

  return query
  select
    c.id as chunk_id,
    c.knowledge_source_id,
    c.content,
    (1 - (c.embedding <=> p_embedding))::real as similarity,
    c.metadata
  from public.ai_chunks c
  join public.ai_knowledge_versions v on v.id=c.kb_version_id and v.organization_id=c.organization_id
  where c.organization_id = p_organization_id
    and c.kb_version_id = p_kb_version_id
    and v.embedding_model='openai/text-embedding-3-small' and v.embedding_dims=1536
    and (1 - (c.embedding <=> p_embedding)) >= p_threshold
  order by c.embedding <=> p_embedding asc
  limit greatest(p_k, 0);
end $$;

revoke execute on function public.fn_buscar_trechos_das_fontes(uuid,uuid[],public.vector,integer,real,text) from public,anon;
grant execute on function public.fn_buscar_trechos_das_fontes(uuid,uuid[],public.vector,integer,real,text) to authenticated,service_role;
revoke execute on function public.retrieve_top_k_chunks(uuid,uuid,public.vector,integer,real) from public,anon;
grant execute on function public.retrieve_top_k_chunks(uuid,uuid,public.vector,integer,real) to authenticated,service_role;

notify pgrst, 'reload schema';
