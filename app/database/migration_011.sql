-- ============================================================================
-- FOR SCHOOL — Migração 011
-- ============================================================================
-- Adiciona "modo de autorização" no termo. Cada termo cadastrado escolhe se:
--   - 'choice'         → pai vê os 2 checkboxes (individual / turma) e escolhe
--                        o que quer autorizar (default atual)
--   - 'all_or_nothing' → não mostra checkboxes; o termo já diz claramente o que
--                        está autorizando, e o pai só confirma OU recusa
--
-- Útil pra termos de formatura/Paspatur onde não faz sentido oferecer
-- "só individual" ou "só turma" — o pai autoriza tudo ou não autoriza.
--
-- Como executar:
--   1. SQL Editor → New query
--   2. Cole este arquivo
--   3. Run
--   4. Esperado: "Success. No rows returned"
-- ============================================================================

alter table public.authorization_terms
  add column if not exists authorization_mode text not null default 'choice'
    check (authorization_mode in ('choice','all_or_nothing'));


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Confira no Table Editor:
--   - authorization_terms  → coluna nova authorization_mode (default 'choice')
-- ============================================================================
