-- ============================================================================
-- FOR SCHOOL — Migração 010
-- ============================================================================
-- Estende cadastro do responsável com dados pra preencher o termo de
-- autorização automaticamente:
--
--   - users.rg            → RG do responsável
--   - users.relationship  → Grau de parentesco (Pai, Mãe, Avô, etc.)
--
-- CPF já existia (users.cpf). A obrigatoriedade vai vir do portal (validação
-- de UI), não do banco — pra não quebrar usuários antigos que cadastraram
-- sem CPF.
--
-- Como executar:
--   1. SQL Editor → New query
--   2. Cole este arquivo
--   3. Run
--   4. Esperado: "Success. No rows returned"
-- ============================================================================

alter table public.users
  add column if not exists rg text;

alter table public.users
  add column if not exists relationship text;   -- "Pai", "Mãe", "Avô", "Avó", "Tio", "Tia", "Outro"


-- ----------------------------------------------------------------------------
-- Atualiza a trigger handle_new_user pra capturar RG e parentesco do signup
-- ----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, name, cpf, rg, phone, email, relationship, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', ''),
    new.raw_user_meta_data ->> 'cpf',
    new.raw_user_meta_data ->> 'rg',
    new.raw_user_meta_data ->> 'phone',
    new.email,
    new.raw_user_meta_data ->> 'relationship',
    coalesce(new.raw_app_meta_data ->> 'role', 'parent')
  );
  return new;
end;
$$;


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Confira no Table Editor:
--   - users  → 2 colunas novas: rg, relationship
-- ============================================================================
