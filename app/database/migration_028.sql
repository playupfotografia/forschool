-- migration_028: taxa de antecipacao do Asaas
--
-- Contexto:
--   Cartao de credito no Asaas cai em 32 dias. Antecipar custa um percentual
--   AO MES (tabela de 02/09/2026, antecipacao automatica ativada):
--     a vista       1,15% ao mes  -> ~1,15% (cai em ~1 mes)
--     parcelado 2x  1,60% ao mes  -> ~2,6%  (a 2a parcela cai em ~2 meses)
--   Antecipacao manual e mais cara: 1,25% e 1,70%.
--
--   A taxa fica em campo separado (em vez de somada na taxa do cartao) pra
--   deixar visivel de onde vem o custo e permitir desligar sem recalcular nada.
--
--   PIX nao entra: cai na hora, nao ha o que antecipar.
--
-- Rodar no SQL Editor do Supabase.

-- Liga/desliga o repasse da antecipacao no calculo do cartao
alter table public.app_settings
  add column if not exists anticipation_enabled boolean not null default false;

-- Percentual efetivo somado a taxa do cartao a vista
alter table public.app_settings
  add column if not exists anticipation_fee_percent numeric(6,4) not null default 1.15;

-- Percentual efetivo somado a taxa do cartao parcelado (2x)
alter table public.app_settings
  add column if not exists anticipation_fee_percent_installment numeric(6,4) not null default 2.60;


-- ----------------------------------------------------------------------------
-- Taxas conferidas no painel da conta de producao em 02/09/2026.
-- Mudou desde a migration_027: apareceu a taxa fixa de R$ 0,49 no credito, e
-- o parcelado 2 a 6x caiu de 3,49% para 2,99% (mesmo valor do a vista).
-- ----------------------------------------------------------------------------

update public.app_settings set
  card_fee_percent             = 2.99,   -- credito a vista
  card_fee_percent_installment = 2.99,   -- credito 2 a 6 parcelas (era 3.49)
  card_fee_fixed               = 0.49,   -- taxa fixa do credito (era 0.00)
  debit_fee_percent            = 1.89,   -- debito
  debit_fee_fixed              = 0.35,   -- taxa fixa do debito
  pix_fee_fixed                = 0,      -- PIX Dinamico e' gratuito
  min_installment_value        = 40,
  max_installments             = 2,
  anticipation_enabled         = false,  -- decisao comercial: ligar no admin
  anticipation_fee_percent             = 1.15,  -- antecipacao automatica, a vista
  anticipation_fee_percent_installment = 2.60   -- 1,6%/mes x ~1,6 meses no 2x
where id = 1;


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Confira no Table Editor:
--   app_settings -> 3 colunas novas (anticipation_enabled,
--                   anticipation_fee_percent, anticipation_fee_percent_installment)
--
-- Nasce DESLIGADO: ligue em Admin -> Configuracoes -> Pagamento online.
-- ============================================================================
