-- ============================================================================
-- FOR SCHOOL — Migração 013
-- ============================================================================
-- Move order_deadline para project_sessions.
--
-- Contexto:
--   Cada sessão de ensaio tem sua própria data limite de pedido.
--   Ex: sessão de 05/07 tem prazo até 04/07;
--       sessão de 11/07 tem prazo até 10/07.
--   A data de entrega das fotos continua ÚNICA por projeto (em projects.delivery_date).
--   O campo projects.order_deadline é mantido por compatibilidade mas
--   passa a ser ignorado pela UI — as sessões são a fonte verdadeira.
--
-- Como executar:
--   SQL Editor do Supabase → New query → Cole → Run
--   Esperado: "Success. No rows returned"
-- ============================================================================

-- Adiciona order_deadline em project_sessions
alter table public.project_sessions
  add column if not exists order_deadline date;

-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Conferir no Table Editor:
--   - project_sessions → nova coluna order_deadline (nullable)
-- ============================================================================
