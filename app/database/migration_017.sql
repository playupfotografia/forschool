-- ============================================================================
-- FOR SCHOOL — Migração 017
-- ============================================================================
-- Histórico de autorizações de imagem por aluno
--
-- Adiciona authorization_log (array JSONB) em students.
-- Cada entrada do array:
--   { action: 'authorized'|'denied'|'reset', date: ISO, signed_by?, individual?, class? }
--
-- Como executar:
--   SQL Editor do Supabase → New query → Cole → Run
--   Esperado: "Success. No rows returned"
-- ============================================================================

alter table public.students
  add column if not exists authorization_log jsonb not null default '[]'::jsonb;

-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Conferir no Table Editor:
--   - students → nova coluna authorization_log (tipo jsonb, default [])
-- ============================================================================
