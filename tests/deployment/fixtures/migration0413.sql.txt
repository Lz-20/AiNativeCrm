-- Expand only. No mutation of events, old versions, vectors or 0412 approvals.
-- A price review is a HUMAN attestation of an upper price and a provider-enforced
-- input-token ceiling, with immutable evidence. There are deliberately NO seeds.
create table if not exists public.ai_embedding_price_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  fingerprint text not null check (fingerprint ~ '^embedding:v1:[a-f0-9]{64}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  price_per_million_microcents bigint not null check (price_per_million_microcents >= 0),
  input_token_ceiling integer not null check (input_token_ceiling between 1 and 32768),
  input_byte_ceiling integer not null check (input_byte_ceiling between 1 and 32000),
  evidence_url text not null check (evidence_url ~ '^https://'),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  token_bound_evidence_sha256 text not null check (token_bound_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  reviewed_by uuid not null references auth.users(id),
  reviewed_at timestamptz not null default now(),
  expires_at timestamptz not null check (expires_at > reviewed_at),
  unique (organization_id,id)
);

create table if not exists public.ai_embedding_operations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  knowledge_source_id uuid not null references public.ai_knowledge_sources(id),
  kind text not null check (kind in ('index','query','validation')),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  source_revision_hash text not null check (source_revision_hash ~ '^[a-f0-9]{64}$'),
  manifest_hash text not null check (manifest_hash ~ '^[a-f0-9]{64}$'),
  -- Hashes/byte lengths only: no document, prompts, credentials or customer data.
  manifest jsonb not null check (jsonb_typeof(manifest)='array' and jsonb_array_length(manifest) between 1 and 10000),
  fingerprint text not null check (fingerprint ~ '^embedding:v1:[a-f0-9]{64}$'),
  configuration_version uuid not null,
  price_review_id uuid not null,
  approved_by uuid not null references auth.users(id),
  approved_at timestamptz not null default now(),
  not_before timestamptz not null default now(),
  expires_at timestamptz not null,
  max_requests integer not null check (max_requests between 1 and 10000),
  max_request_tokens integer not null check (max_request_tokens > 0),
  max_total_tokens bigint not null check (max_total_tokens > 0),
  max_cost_microcents bigint not null check (max_cost_microcents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  reserved_requests integer not null default 0 check (reserved_requests >= 0 and reserved_requests <= max_requests),
  reserved_tokens bigint not null default 0 check (reserved_tokens >= 0 and reserved_tokens <= max_total_tokens),
  reserved_cost_microcents bigint not null default 0 check (reserved_cost_microcents >= 0 and reserved_cost_microcents <= max_cost_microcents),
  knowledge_version_id uuid references public.ai_knowledge_versions(id),
  status text not null default 'approved' check (status in ('approved','running','completed','blocked','revoked')),
  lease_owner uuid,
  lease_until timestamptz,
  fence bigint not null default 0,
  last_error text,
  completed_at timestamptz,
  foreign key (organization_id,price_review_id) references public.ai_embedding_price_reviews(organization_id,id),
  check (expires_at > not_before and expires_at > approved_at),
  unique (organization_id,id),
  unique (organization_id,knowledge_source_id,kind,content_hash,source_revision_hash,fingerprint,configuration_version,manifest_hash)
);
-- Even different configurations/content must not run concurrently for a source.
create unique index if not exists embedding_operation_source_running
  on public.ai_embedding_operations(organization_id,knowledge_source_id) where kind='index' and status='running';

create table if not exists public.ai_embedding_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  operation_id uuid not null,
  input_position integer not null check (input_position >= 0),
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  fence bigint not null,
  status text not null default 'reserved' check (status in ('reserved','succeeded','unknown','rejected')),
  reserved_tokens integer not null check (reserved_tokens >= 0),
  reserved_cost_microcents bigint not null check (reserved_cost_microcents >= 0),
  reused_from_request_id uuid,
  actual_tokens integer check (actual_tokens >= 0),
  actual_cost_microcents bigint check (actual_cost_microcents >= 0 and actual_cost_microcents <= reserved_cost_microcents),
  response_embedding public.vector,
  upstream_request_id text check (length(upstream_request_id) <= 200),
  latency_ms integer check (latency_ms >= 0),
  error_code text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (organization_id,operation_id) references public.ai_embedding_operations(organization_id,id),
  unique (organization_id,id),
  foreign key (organization_id,reused_from_request_id) references public.ai_embedding_requests(organization_id,id),
  check ((reused_from_request_id is null and reserved_tokens > 0) or
    (reused_from_request_id is not null and reserved_tokens=0 and reserved_cost_microcents=0)),
  check (actual_tokens is null or reused_from_request_id is not null or actual_tokens <= reserved_tokens),
  unique (organization_id,operation_id,input_position)
);

alter table public.ai_embedding_price_reviews enable row level security;
alter table public.ai_embedding_operations enable row level security;
alter table public.ai_embedding_requests enable row level security;
drop policy if exists embedding_price_review_read on public.ai_embedding_price_reviews;
create policy embedding_price_review_read on public.ai_embedding_price_reviews for select to authenticated
  using (public.fn_role_at_least(organization_id,'manager'));
drop policy if exists embedding_operation_read on public.ai_embedding_operations;
create policy embedding_operation_read on public.ai_embedding_operations for select to authenticated
  using (public.fn_role_at_least(organization_id,'manager'));
-- Request vectors are private to the server, even for managers. The API projects
-- safe accounting fields explicitly. Supabase default grants must be revoked.
revoke all on public.ai_embedding_price_reviews,public.ai_embedding_operations,public.ai_embedding_requests from public,anon,authenticated,service_role;
grant select on public.ai_embedding_price_reviews,public.ai_embedding_operations to authenticated;
grant select,insert on public.ai_embedding_price_reviews to service_role;
grant select,insert,update on public.ai_embedding_operations,public.ai_embedding_requests to service_role;
