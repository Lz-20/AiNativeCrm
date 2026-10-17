-- 0395 — optional, user-selected observable CRM conditions. Free-text
-- acceptance remains authoritative for the business decision.
alter table public.ai_missions
  add column if not exists acceptance_contract jsonb;

create or replace function public.fn_valid_ai_mission_acceptance_contract(p jsonb)
returns boolean
language plpgsql immutable
set search_path = public
as $$
declare
  item jsonb;
  seen text[] := '{}';
  kind text;
begin
  if p is null then return true; end if;
  if jsonb_typeof(p) is distinct from 'object' then return false; end if;
  if p->'revision' is distinct from '1'::jsonb
     or (select count(*) from jsonb_object_keys(p)) <> 2
     or jsonb_typeof(p->'checks') is distinct from 'array' then return false; end if;
  if jsonb_array_length(p->'checks') not between 1 and 2 then return false; end if;
  for item in select value from jsonb_array_elements(p->'checks') loop
    if jsonb_typeof(item) is distinct from 'object' then return false; end if;
    kind := item->>'kind';
    if kind = any(seen) then return false; end if;
    if kind = 'lead_status' then
      if item->>'equals' is null or item->>'equals' not in ('open', 'won', 'lost')
         or (select count(*) from jsonb_object_keys(item)) <> 2 then return false; end if;
    elsif kind = 'customer_inbound_after_verified_send' then
      if (select count(*) from jsonb_object_keys(item)) <> 1 then return false; end if;
    else
      return false;
    end if;
    seen := array_append(seen, kind);
  end loop;
  return true;
end;
$$;
revoke all on function public.fn_valid_ai_mission_acceptance_contract(jsonb) from public, anon, authenticated;
grant execute on function public.fn_valid_ai_mission_acceptance_contract(jsonb) to service_role;

alter table public.ai_missions
  drop constraint if exists ai_missions_acceptance_contract_shape_check;
alter table public.ai_missions
  add constraint ai_missions_acceptance_contract_shape_check
  check (public.fn_valid_ai_mission_acceptance_contract(acceptance_contract));

comment on column public.ai_missions.acceptance_contract is
  'Optional revisioned observable checks; matching them does not prove free-text business acceptance.';

notify pgrst, 'reload schema';
