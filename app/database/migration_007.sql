-- ============================================================================
-- FOR SCHOOL — Migração 007
-- ============================================================================
-- Métodos de pagamento configuráveis POR ESCOLA + regra global de
-- parcelamento mínimo.
--
-- Cada escola pode ter qualquer combinação de:
--   1. PIX manual (chave fixa da empresa)
--   2. PIX automático via Inter Cobranças (integração futura)
--   3. Link externo (SumUp / Mercado Pago / qualquer Pay-by-Link)
--
-- Regras globais (em app_settings):
--   - Parcelamento (2x) disponível só pra pedidos a partir de R$ X
--
-- Como executar:
--   1. SQL Editor → New query
--   2. Cole este arquivo
--   3. Run
--   4. Esperado: "Success. No rows returned"
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Flags por escola — quais métodos estão liberados pros pais
-- ----------------------------------------------------------------------------

alter table public.schools
  add column if not exists payment_pix_manual boolean not null default true;

alter table public.schools
  add column if not exists payment_inter boolean not null default false;

alter table public.schools
  add column if not exists payment_external_link boolean not null default false;


-- ----------------------------------------------------------------------------
-- 2. Regras globais de parcelamento
-- ----------------------------------------------------------------------------

alter table public.app_settings
  add column if not exists min_installment_value numeric(10,2) not null default 100;

alter table public.app_settings
  add column if not exists max_installments int not null default 2;


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Confira no Table Editor:
--   - schools          → 3 colunas novas (payment_pix_manual, payment_inter,
--                                          payment_external_link)
--   - app_settings     → 2 colunas novas (min_installment_value,
--                                          max_installments)
-- ============================================================================
