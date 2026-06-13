-- ============================================================================
-- FOR SCHOOL — Migração 014
-- ============================================================================
-- Libera kits e preços por projeto (remove constraints de unicidade por escola).
--
-- Contexto:
--   school_kits e school_prices tinham unique(school_id, kit_type) e
--   unique(school_id, product_id) respectivamente. Isso funcionava quando
--   kits e preços eram por escola. Agora que são por PROJETO, precisamos de:
--     - unique(project_id, kit_type)    quando project_id não é nulo
--     - unique(project_id, product_id)  quando project_id não é nulo
--   Registros sem project_id (legado, vinculados à escola) continuam
--   com unique(school_id, X) via índice parcial.
--
-- Como executar:
--   SQL Editor do Supabase → New query → Cole → Run
--   Esperado: "Success. No rows returned"
-- ============================================================================


-- ============================================================================
-- 1. school_kits — troca de constraint
-- ============================================================================

-- Remove constraint antiga
alter table public.school_kits
  drop constraint if exists school_kits_school_id_kit_type_key;

-- Escola-level (sem projeto): unique por escola + tipo
create unique index if not exists idx_school_kits_school_type_null
  on public.school_kits(school_id, kit_type)
  where project_id is null;

-- Projeto-level: unique por projeto + tipo
create unique index if not exists idx_school_kits_proj_type
  on public.school_kits(project_id, kit_type)
  where project_id is not null;


-- ============================================================================
-- 2. school_prices — troca de constraint
-- ============================================================================

-- Remove constraint antiga
alter table public.school_prices
  drop constraint if exists school_prices_school_id_product_id_key;

-- Escola-level (sem projeto): unique por escola + produto
create unique index if not exists idx_school_prices_school_prod_null
  on public.school_prices(school_id, product_id)
  where project_id is null;

-- Projeto-level: unique por projeto + produto
create unique index if not exists idx_school_prices_proj_prod
  on public.school_prices(project_id, product_id)
  where project_id is not null;


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Conferir no Table Editor:
--   - school_kits   → constraint school_kits_school_id_kit_type_key removida
--   - school_prices → constraint school_prices_school_id_product_id_key removida
--   - Indexes → 4 novos índices criados (_null e _proj/_proj_prod)
-- ============================================================================
