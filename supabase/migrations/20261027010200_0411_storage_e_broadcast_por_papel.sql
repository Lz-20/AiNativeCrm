-- Forward fix: direto no Storage e no Broadcast vale o mesmo papel da aplicação.
-- Não altera dados, owners, roles, schemas gerenciados nem permissões de tabela.
-- O baseline congelado do staging recebe este apêndice só APÓS a inicialização.

create or replace function public.fn_membro_ativo_com_papel(p_org uuid, p_min text)
returns boolean language plpgsql stable security definer set search_path = '' as $fn$
declare suporte jsonb;
begin
  if auth.uid() is null or not public.fn_session_mfa_proven()
     or not exists(select 1 from public.organizations where id=p_org and status='active') then
    return false;
  end if;
  suporte := public.fn_support_context();
  -- Uma sessão de suporte encerrada, ou voltada a outro tenant, não reabre os
  -- vínculos normais do operador; a aplicação também exige sair desse contexto.
  if suporte is not null then
    return coalesce(suporte->>'status'='active'
      and suporte->>'organization_id'=p_org::text
      and public.fn_role_at_least(p_org,p_min),false);
  end if;
  return public.fn_role_at_least(p_org,p_min) and exists (
    select 1 from public.user_organizations
    where organization_id=p_org and user_id=auth.uid()
      and revoked_at is null and accepted_at is not null
  );
end $fn$;
revoke all on function public.fn_membro_ativo_com_papel(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.fn_membro_ativo_com_papel(uuid,text) to authenticated,service_role;

-- CASE evita cast de um nome malformado; não depende da ordem do planner.
alter policy tenant_read_ai_policy on storage.objects to authenticated using (
  bucket_id='ai-policy' and case
    when split_part(name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then public.fn_membro_ativo_com_papel(split_part(name,'/',1)::uuid,'viewer') else false end
);
alter policy tenant_write_ai_policy on storage.objects to authenticated with check (
  bucket_id='ai-policy' and case
    when split_part(name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then public.fn_membro_ativo_com_papel(split_part(name,'/',1)::uuid,'manager') else false end
);
alter policy tenant_delete_ai_policy on storage.objects to authenticated using (
  bucket_id='ai-policy' and case
    when split_part(name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then public.fn_membro_ativo_com_papel(split_part(name,'/',1)::uuid,'manager') else false end
);
alter policy tenant_read_lgpd_exports on storage.objects to authenticated using (
  bucket_id='lgpd-exports' and case
    when split_part(name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then public.fn_membro_ativo_com_papel(split_part(name,'/',1)::uuid,'admin') else false end
);

do $publication$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists (
    select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='conversation_notes'
  ) then
    alter publication supabase_realtime add table public.conversation_notes;
  end if;
end $publication$;

create or replace function public.fn_broadcast_topic_permitido(p_topic text)
returns boolean language plpgsql stable security definer set search_path = '' as $fn$
begin
  if auth.uid() is null or not public.fn_session_mfa_proven() then return false; end if;
  if p_topic='alerts-platform' or p_topic ~* '^tenant-(health|agents)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    -- Cadastro obrigatório e prova de fator já cadastrado são perguntas
    -- diferentes: fn_session_mfa_proven sozinho permite aal1 sem fator.
    -- Mantém o contrato de requirePlatformAdmin para mfa_required=true.
    return public.fn_support_context() is null and exists (
      select 1 from public.platform_admins p
      where p.user_id=auth.uid() and p.revoked_at is null
        and (not p.mfa_required or coalesce(auth.jwt()->>'aal','aal1')='aal2')
    );
  end if;
  if p_topic ~* '^org:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:queue$' then
    return public.fn_membro_ativo_com_papel(split_part(p_topic,':',2)::uuid,'viewer');
  end if;
  return false;
end $fn$;
revoke all on function public.fn_broadcast_topic_permitido(text) from public,anon,authenticated,service_role;
grant execute on function public.fn_broadcast_topic_permitido(text) to authenticated,service_role;

-- Leitura de canais privados do CRM. Nenhuma policy INSERT é concedida ao
-- browser: handoff/alertas são emitidos pelo servidor, não pelo usuário.
-- O teste PostgreSQL mínimo não tem Realtime; a instalação Supabase e o gate
-- de aceitação exigem a tabela real e verificam esta policy após aplicar.
do $broadcast$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists crm_broadcast_read on realtime.messages';
    execute $policy$create policy crm_broadcast_read on realtime.messages for select to authenticated
      using (extension='broadcast' and public.fn_broadcast_topic_permitido(realtime.topic()))$policy$;
  else
    raise notice 'Realtime managed table absent: Broadcast authorization requires Supabase acceptance';
  end if;
end $broadcast$;

notify pgrst, 'reload schema';
