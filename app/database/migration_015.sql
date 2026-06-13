-- ============================================================================
-- FOR SCHOOL — Migração 015
-- ============================================================================
-- Vincula pedidos ao projeto (project_id em orders).
--
-- Contexto:
--   orders tinha apenas school_id. Com projetos, um pedido deve ser
--   vinculado ao projeto específico (slug do portal). Isso permite
--   drill-down "alunos/pedidos por projeto" e relatórios multi-projeto.
--   Pedidos antigos ficam com project_id NULL — tratados como "escola geral".
--
-- Como executar:
--   SQL Editor do Supabase → New query → Cole → Run
--   Esperado: "Success. No rows returned"
-- ============================================================================

alter table public.orders
  add column if not exists project_id uuid references public.projects(id) on delete set null;

create index if not exists idx_orders_project on public.orders(project_id);

-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Conferir no Table Editor:
--   - orders → nova coluna project_id (nullable, FK → projects)
--   - Indexes → idx_orders_project criado
-- ============================================================================
