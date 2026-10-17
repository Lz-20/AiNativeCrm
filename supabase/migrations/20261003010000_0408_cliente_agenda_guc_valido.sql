-- Forward fix 0408: PostgreSQL custom GUC prefixes cannot contain hyphens.
-- Replace only the two affected function bodies; preserve signatures, ACLs,
-- tenant filters, row locks, trigger ordering and transaction-local authority.
create or replace function public.fn_recalcular_cliente_do_contato(p_org uuid, p_contact uuid, p_emitir boolean)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_etiqueta constant text := 'cliente';
  v_antes timestamptz;
  v_tags text[];
  v_reconhecido timestamptz;
  v_dono text;
  v_depois timestamptz;
  v_tem boolean;
  v_novas text[];
  v_resultado text;
begin
  -- TRAVA O CONTATO ANTES DE LER A AGENDA. Na ordem inversa, duas marcações
  -- simultâneas do mesmo contato gravam um min() velho por cima do certo: em
  -- READ COMMITTED o min() lido DEPOIS da trava enxerga a marcação concorrente
  -- que já commitou.
  --
  -- `for no key update`, e não `for update`: é a trava que o UPDATE abaixo toma
  -- de qualquer jeito, e ela não conflita com o `for key share` que a FK de toda
  -- tabela que aponta para `contacts` toma num INSERT. Medido com `for update`:
  -- a ligação da regra (trava da organização, depois o contato) e um INSERT de
  -- agendamento (a FK trava o contato, depois o trigger espera a trava da
  -- organização) fechavam `deadlock detected`.
  --
  -- Anonimizado e mesclado não recebem escrita derivada nova: sem esta guarda
  -- um agendamento posterior faria "Cliente Anonimizado #N" reaparecer
  -- etiquetado.
  select c.first_service_at, coalesce(c.tags, '{}'::text[]), c.client_recognized_at, c.client_tag_by_system
    into v_antes, v_tags, v_reconhecido, v_dono
    from public.contacts c
   where c.organization_id = p_org
     and c.id = p_contact
     and c.is_anonymized = false
     and c.is_merged_into is null
   for no key update;
  if not found then
    return 'ignorado';
  end if;

  select min(least(a.created_at, a.starts_at)) into v_depois
    from public.calendar_appointments a
   where a.organization_id = p_org
     and a.contact_id = p_contact
     and public.fn_situacao_conta_como_atendimento(a.status);

  -- O caso comum — cliente antigo marcando a enésima hora — não escreve nada:
  -- `updated_at` não se move e o contato não vira ruído de realtime.
  if v_antes is not distinct from v_depois then
    return 'igual';
  end if;

  v_tem := c_etiqueta = any(v_tags);

  -- REDE, e não mais a regra: quem lê o que a equipe fez é a guarda da seção
  -- 4b, na hora da escrita. Isto aqui alcança os dois casos que ela não vê —
  -- um banco que aplicou uma versão anterior desta migration (a etiqueta mudou
  -- de mão antes de a guarda existir) e uma restauração com
  -- `session_replication_role = replica`, que desliga trigger.
  if (v_dono = 'added' and not v_tem) or (v_dono = 'removed' and v_tem) then
    v_dono := null;
  end if;

  -- `array_append`/`array_remove` e não `||`: sem cast, o `||` lê o literal
  -- como ARRAY e morre em `malformed array literal` (medido pelo autor no CI).
  v_novas := v_tags;
  if v_antes is null then
    -- Virou cliente. A etiqueta entra se nunca foi reconhecido (a primeira vez)
    -- ou se foi o sistema que a tirou. Se a equipe a tirou, fica fora.
    if not v_tem and (v_reconhecido is null or v_dono = 'removed') then
      v_novas := array_append(v_tags, c_etiqueta);
      v_dono := 'added';
      v_resultado := 'etiquetado';
    else
      v_resultado := 'virou_cliente';
    end if;
  elsif v_depois is null then
    -- Deixou de ser cliente. Só sai a etiqueta que é do sistema.
    if v_tem and v_dono = 'added' then
      v_novas := array_remove(v_tags, c_etiqueta);
      v_dono := 'removed';
      v_resultado := 'desetiquetado';
    else
      v_resultado := 'deixou_de_ser_cliente';
    end if;
  else
    v_resultado := 'mudou_a_data';
  end if;

  -- A ESCRITA SE ANUNCIA. `auth.uid()` continua preenchido aqui dentro — uma
  -- `security definer` troca o dono da função, nunca o JWT da sessão —, então
  -- sem um sinal explícito a guarda da seção 4b barraria o próprio sistema. A
  -- chave é de TRANSAÇÃO (`set_config(..., true)`) e volta a 'off' na linha
  -- seguinte: a janela é o UPDATE, não o resto da transação.
  perform set_config('pi_native.cliente_pela_agenda', 'on', true);

  update public.contacts
     set first_service_at = v_depois,
         client_recognized_at = coalesce(v_reconhecido, case when v_depois is not null then now() end),
         client_tag_by_system = v_dono,
         tags = v_novas,
         updated_at = now()
   where organization_id = p_org
     and id = p_contact;

  perform set_config('pi_native.cliente_pela_agenda', 'off', true);

  -- UMA VEZ POR CONTATO: só quando a etiqueta entra na primeira vez que a regra
  -- o reconhece.
  if v_resultado = 'etiquetado' and v_reconhecido is null and p_emitir then
    -- O MESMO formato que o app emite (app/api/v1/contacts/_handler.ts e
    -- lib/automation/actions/add-tag.ts): `added_tags` + `tags`.
    --
    -- SEM `service_origin`: `emit_event` o carimba sozinho para
    -- contact.tag_added, e o recusaria (42501) vindo de sessão autenticada.
    -- SEM `caused_by_rule`: a automação TEM de ver este evento.
    -- Trigger nunca faz HTTP: a linha vai para event_log e o worker consome.
    perform public.emit_event(
      'contact.tag_added',
      'contact',
      p_contact,
      jsonb_build_object('added_tags', jsonb_build_array(c_etiqueta), 'tags', to_jsonb(v_novas)),
      jsonb_build_object('actor_type', 'system', 'actor_id', 'trg_agendamento_marca_cliente'),
      p_org
    );
  end if;

  return v_resultado;
end $$;

revoke execute on function public.fn_recalcular_cliente_do_contato(uuid, uuid, boolean) from public, anon, authenticated;
create or replace function public.fn_colunas_de_cliente_sao_do_sistema()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  c_etiqueta constant text := 'cliente';
begin
  if auth.uid() is not null
     and coalesce(current_setting('pi_native.cliente_pela_agenda', true), '') <> 'on'
     and (old.first_service_at is distinct from new.first_service_at
       or old.client_recognized_at is distinct from new.client_recognized_at
       or old.client_tag_by_system is distinct from new.client_tag_by_system) then
    raise exception 'colunas_de_cliente_sao_do_sistema' using errcode = '42501';
  end if;

  if new.client_tag_by_system is not null
     and old.client_tag_by_system is not distinct from new.client_tag_by_system
     and (c_etiqueta = any(coalesce(old.tags, '{}'::text[])))
         is distinct from (c_etiqueta = any(coalesce(new.tags, '{}'::text[]))) then
    new.client_tag_by_system := null;
  end if;

  return new;
end $$;

comment on function public.fn_colunas_de_cliente_sao_do_sistema() is
  'Guarda de contacts (migration 0262): sessão nenhuma grava first_service_at, client_recognized_at ou '
  'client_tag_by_system (42501 colunas_de_cliente_sao_do_sistema); o service role e as migrations passam. '
  'E quem mexe na etiqueta cliente sem gravar o dono na mesma escrita vira o dono dela, o que é como a '
  'remoção à mão passa a ser respeitada NA HORA. Provado em tests/invariants/cliente-nasce-do-agendamento.test.ts.';

-- Função de trigger não exige EXECUTE de quem dispara o UPDATE; revogar das
-- duas origens (o grant a PUBLIC e o grant direto a `anon` do baseline) não
-- quebra nada.
revoke execute on function public.fn_colunas_de_cliente_sao_do_sistema() from public, anon, authenticated;
