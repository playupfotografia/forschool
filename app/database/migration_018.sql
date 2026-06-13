-- ============================================================================
-- FOR SCHOOL — Migração 018
-- ============================================================================
-- Adiciona campos de segundo responsável na tabela students.
--
-- Contexto:
--   O sistema registra apenas o responsável que se cadastrou no portal
--   (vínculo via user_id → users). Para ter o nome e contato de ambos os
--   responsáveis (pai e mãe, por exemplo), adicionamos 3 campos simples
--   diretamente em students. O 2º responsável não precisa ter login no portal.
--
-- Como executar:
--   SQL Editor do Supabase → New query → Cole → Run
--   Esperado: "Success. No rows returned"
-- ============================================================================

alter table public.students
  add column if not exists guardian2_name         text,
  add column if not exists guardian2_phone        text,
  add column if not exists guardian2_relationship text;

-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Conferir no Table Editor:
--   - students → 3 novas colunas (guardian2_name, guardian2_phone, guardian2_relationship)
-- ============================================================================
