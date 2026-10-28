-- Credenciais de recuperação, resolução de entrada e autoria de auditoria
-- pertencem ao servidor. auth.uid() sozinho também aceita sessões AAL1.
-- Nenhum dado existente é alterado; a reaplicação repõe o mesmo contrato.

-- Enrollment confirma o TOTP antes do INSERT; rotação exige sessão AAL2;
-- consumo faz UPDATE condicional e só o vencedor remove os fatores.
-- Todos usam o admin client. Nem mesmo AAL2 precisa ler hashes pela REST.
alter table public.user_recovery_codes enable row level security;
drop policy if exists recovery_codes_self on public.user_recovery_codes;
revoke all on table public.user_recovery_codes from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.user_recovery_codes to service_role;

-- O consumidor é workers/voice-agent, com service_role. O GRANT padrão de
-- funções do Supabase também alcança authenticated: revogar só anon não basta.
revoke execute on function public.fn_resolve_inbound_number(text) from public, anon, authenticated;
grant execute on function public.fn_resolve_inbound_number(text) to service_role;

-- Uma linha append-only ainda pode ter sido inventada pelo cliente. Atribuição,
-- contexto de suporte e eventos sem sessão são escritos por audit() no servidor
-- ou pelas triggers SECURITY DEFINER; a leitura tenant-aware permanece intacta.
drop policy if exists audit_log_insert_tenant_member on public.api_audit_log;
revoke insert on table public.api_audit_log from public, anon, authenticated;
revoke update, delete, truncate on table public.api_audit_log from public, anon, authenticated, service_role;
grant select, insert on table public.api_audit_log to service_role;

notify pgrst, 'reload schema';
