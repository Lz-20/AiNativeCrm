-- Confirmed customer memory is owned by CRM; an external ID is only a projection.
create unique index if not exists contacts_id_org_memory_uidx on public.contacts(id,organization_id);
create table if not exists public.ai_customer_memories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid,
  subject_key text not null check (subject_key ~ '^[a-f0-9]{64}$'),
  request_key uuid not null,
  category text not null check (category in ('preference','confirmed_fact','communication_context')),
  body text not null check (char_length(body)<=2000),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  confirmed_by uuid references auth.users(id) on delete set null,
  sync_state text not null default 'pending' check (sync_state in ('pending','sending','synced','reconcile','deleted')),
  external_id text,
  write_started_at timestamptz,
  write_outcome text not null default 'never_started' check(write_outcome in ('never_started','in_flight','confirmed','unknown')),
  deleted_at timestamptz,
  remote_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,request_key),
  foreign key(contact_id,organization_id) references public.contacts(id,organization_id) on delete set null (contact_id)
);
alter table public.ai_customer_memories enable row level security;
revoke all on public.ai_customer_memories from public,anon,authenticated;
grant select,insert,update,delete on public.ai_customer_memories to service_role;
-- A contact privacy change retains a content-free external cleanup receipt.
create or replace function public.fn_ai_customer_memory_privacy() returns trigger
language plpgsql security definer set search_path=public as $$
declare owner_org uuid; owner_contact uuid;
begin
  if TG_OP='DELETE' then owner_org:=old.organization_id; owner_contact:=old.id;
  elsif new.is_anonymized is true or new.is_merged_into is not null then
    owner_org:=new.organization_id; owner_contact:=new.id;
  else return new;
  end if;
  with retired as (
    update public.ai_customer_memories set body='',
      remote_deleted_at=case when write_outcome='never_started' then now() else remote_deleted_at end,
      sync_state='deleted',deleted_at=coalesce(deleted_at,now()),updated_at=now()
    where organization_id=owner_org and contact_id=owner_contact and deleted_at is null returning id,organization_id
  )
  insert into public.event_log(organization_id,event_type,entity_kind,entity_id,payload)
    select organization_id,'ai_integration.mem0_sync','ai_customer_memory',id,jsonb_build_object('memory_id',id) from retired;
  if TG_OP='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function public.fn_ai_customer_memory_privacy() from public,anon,authenticated;
drop trigger if exists trg_ai_customer_memory_privacy on public.contacts;
create trigger trg_ai_customer_memory_privacy before update of is_anonymized,is_merged_into or delete on public.contacts
  for each row execute function public.fn_ai_customer_memory_privacy();
-- Never erase the last cleanup receipt before external deletion has been verified.
create or replace function public.fn_ai_memory_org_delete_guard() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if exists(select 1 from public.ai_customer_memories where organization_id=old.id
    and sync_state in ('sending','synced','reconcile','deleted') and remote_deleted_at is null) then
    raise exception 'external_customer_memory_cleanup_required';
  end if;
  return old;
end $$;
revoke all on function public.fn_ai_memory_org_delete_guard() from public,anon,authenticated;
drop trigger if exists trg_ai_memory_org_delete_guard on public.organizations;
create trigger trg_ai_memory_org_delete_guard before delete on public.organizations
  for each row execute function public.fn_ai_memory_org_delete_guard();
notify pgrst,'reload schema';
