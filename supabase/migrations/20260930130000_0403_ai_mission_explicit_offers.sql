-- 0403 — explicit, manager-authored quote/delivery terms and channel reply challenge.
-- The code is a correlation nonce, not an authentication secret: the verified
-- inbound channel identity remains the source of customer evidence.
create unique index if not exists conversations_org_id_contact_session_offer_uidx
  on public.conversations(organization_id,id,contact_id,channel_session_id);

create table if not exists public.ai_mission_explicit_offers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  mission_id uuid not null,
  contact_id uuid not null,
  conversation_id uuid not null,
  channel_session_id uuid not null,
  created_by uuid references auth.users(id) on delete set null,
  request_key uuid not null,
  direction_revision bigint not null,
  description text not null check (char_length(description) between 1 and 160
    and position(chr(10) in description)=0 and position(chr(13) in description)=0),
  amount_minor bigint not null check (amount_minor between 1 and 1000000000000),
  currency text not null check (currency in ('BRL','CNY','USD','EUR')),
  delivery_date date not null,
  offer_text text not null check (char_length(offer_text) between 1 and 1000),
  acceptance_text text not null check (char_length(acceptance_text) between 1 and 100),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  superseded_at timestamptz,
  foreign key (mission_id,organization_id)
    references public.ai_missions(id,organization_id) on delete cascade,
  foreign key (organization_id,conversation_id,contact_id,channel_session_id)
    references public.conversations(organization_id,id,contact_id,channel_session_id)
    on delete cascade,
  unique (organization_id,mission_id,request_key),
  unique (organization_id,acceptance_text),
  check (expires_at>issued_at and expires_at<=issued_at+interval '7 days')
);
create unique index if not exists ai_mission_explicit_offers_current_uidx
  on public.ai_mission_explicit_offers(organization_id,mission_id)
  where superseded_at is null;
create index if not exists ai_mission_explicit_offers_history_idx
  on public.ai_mission_explicit_offers(organization_id,mission_id,issued_at desc);
alter table public.ai_mission_explicit_offers enable row level security;
revoke all on public.ai_mission_explicit_offers from public,anon,authenticated;
grant select,insert,update,delete on public.ai_mission_explicit_offers to service_role;
notify pgrst, 'reload schema';
