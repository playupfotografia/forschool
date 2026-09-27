-- migration_062: vencimento FIXO das parcelas do PIX parcelado, por projeto
--
-- Contexto (27/09/2026, projeto "Recordacao Escola MAIS"):
--   Ate aqui, cada parcela do PIX parcelado vencia "30 dias depois da
--   anterior" (criar-parcelamento-pix.js, emDiasISO(30*(k-1))) — contado a
--   partir do dia da COMPRA. O Daniel pediu algo diferente pra esse projeto:
--   a 2a e a 3a parcela sempre vencem em DATAS FIXAS do calendario (05/11 e
--   05/12), nao importa que dia a familia comprou (contanto que seja antes
--   do prazo geral de oferecer parcelamento, projects.pix_parcelas_ate).
--   A 1a parcela continua sendo cobrada na hora da compra, sempre.
--
-- O que muda:
--   projects.pix_venc_parcela2/3/4 -> data fixa (opcional) de vencimento da
--     2a/3a/4a parcela desse projeto. Em branco = mantem o comportamento
--     antigo (30 dias depois da anterior) pra esse numero de parcela — os
--     dois modelos podem conviver (ex: parcela 2 com data fixa, parcela 3
--     sem, caindo no calculo antigo a partir da data da parcela 2).
--
-- Rodar no SQL Editor do Supabase.

alter table public.projects
  add column if not exists pix_venc_parcela2 date,
  add column if not exists pix_venc_parcela3 date,
  add column if not exists pix_venc_parcela4 date;

-- ============================================================================
-- FIM. Nada muda sozinho: as colunas nascem vazias, todo projeto existente
-- continua com o calculo de "30 dias depois da anterior". Configure em
-- Admin -> o projeto -> aba Datas & Pagamento -> "Vencimento fixo das
-- parcelas (opcional)".
-- ============================================================================
