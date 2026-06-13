-- ============================================================================
-- FOR SCHOOL — Migração 006
-- ============================================================================
-- Adiciona suporte a "link de pagamento externo" (SumUp, MP, Inter, qualquer
-- gateway que ofereça Pay-by-Link).
--
-- O admin cola o link nas Configurações. O portal mostra DOIS caminhos
-- pro pai escolher na hora de pagar:
--   1. PIX manual (chave fixa da empresa) — caminho atual
--   2. Botão "Pagar com cartão ou PIX" (abre o link configurado)
--
-- Pra MVP, o link é único e o pai precisa digitar o valor (avisamos antes).
-- Integração programática (link com valor exato + webhook) fica pra
-- iteração futura.
--
-- Como executar:
--   1. SQL Editor → New query
--   2. Cole este arquivo
--   3. Run
--   4. Esperado: "Success. No rows returned"
-- ============================================================================

alter table public.app_settings
  add column if not exists payment_link_url text;

alter table public.app_settings
  add column if not exists payment_link_label text
    default 'Pagar com cartão ou PIX';

-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Confira no Table Editor:
--   - app_settings → 2 colunas novas: payment_link_url, payment_link_label
-- ============================================================================
