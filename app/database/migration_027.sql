-- migration_027: pagamento online (Asaas) — PIX, cartao de credito e debito
--
-- Contexto:
--   Ate' aqui o pagamento era manual: PIX na chave fixa + confirmacao do admin.
--   Esta migracao prepara o banco pro gateway (Asaas), guardando o que a
--   cobranca virou la' e quanto foi efetivamente cobrado do responsavel.
--
--   Regra comercial: a taxa do cartao e' REPASSADA ao responsavel; o PIX nao
--   tem acrescimo (tarifa do PIX Dinamico no Asaas e' zero). O valor com
--   acrescimo e' calculado embutido — (valor + taxa_fixa) / (1 - taxa%) — pra
--   que o valor liquido recebido seja exatamente o preco de tabela.
--
-- Rodar no SQL Editor do Supabase.

-- ----------------------------------------------------------------------------
-- 1. app_settings — taxas e metodos habilitados (editaveis na tela Config)
-- ----------------------------------------------------------------------------

-- Taxas Asaas confirmadas no painel em 02/09/2026.
-- PIX Dinamico: GRATUITO. Credito a' vista: 2,99%. Credito 2 a 6x: 3,49%.
-- Debito: 1,89% + R$ 0,35. Todas sem taxa fixa no credito.
alter table public.app_settings
  add column if not exists card_fee_percent numeric(6,4) not null default 2.99;

alter table public.app_settings
  add column if not exists card_fee_percent_installment numeric(6,4) not null default 3.49;

alter table public.app_settings
  add column if not exists card_fee_fixed numeric(10,2) not null default 0;

alter table public.app_settings
  add column if not exists debit_fee_percent numeric(6,4) not null default 1.89;

alter table public.app_settings
  add column if not exists debit_fee_fixed numeric(10,2) not null default 0.35;

alter table public.app_settings
  add column if not exists pix_fee_fixed numeric(10,2) not null default 0;

-- Quais metodos aparecem no portal
alter table public.app_settings
  add column if not exists pay_pix_enabled boolean not null default true;

alter table public.app_settings
  add column if not exists pay_credit_enabled boolean not null default true;

alter table public.app_settings
  add column if not exists pay_debit_enabled boolean not null default false;

-- 'pass_on' = taxa somada ao valor do pai | 'absorb' = empresa absorve
alter table public.app_settings
  add column if not exists surcharge_mode text not null default 'pass_on';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'app_settings_surcharge_mode_check'
  ) then
    alter table public.app_settings
      add constraint app_settings_surcharge_mode_check
      check (surcharge_mode in ('pass_on','absorb'));
  end if;
end $$;

-- Parcela minima: era 100 (default da migration_007), passa a 40 por decisao
-- comercial. Com max_installments = 2, so' pedidos de R$ 80+ oferecem 2x.
update public.app_settings set min_installment_value = 40 where id = 1;


-- ----------------------------------------------------------------------------
-- 2. orders — dados da cobranca no gateway
-- ----------------------------------------------------------------------------

-- Qual gateway processou ('asaas'); null = pagamento manual, como era antes
alter table public.orders
  add column if not exists gateway text;

-- Status bruto devolvido pelo gateway (PENDING, CONFIRMED, RECEIVED, ...)
alter table public.orders
  add column if not exists gateway_status text;

-- Numero de parcelas escolhido (1 ou 2)
alter table public.orders
  add column if not exists installments int not null default 1;

-- Valor efetivamente cobrado do responsavel (ja' com o acrescimo do cartao).
-- total_amount continua sendo o preco de tabela, que e' o que a Play Up recebe.
alter table public.orders
  add column if not exists amount_charged numeric(10,2);

alter table public.orders
  add column if not exists surcharge_amount numeric(10,2) not null default 0;

-- PIX: codigo copia-e-cola e imagem do QR devolvidos pelo gateway
alter table public.orders
  add column if not exists pix_payload text;

alter table public.orders
  add column if not exists pix_qr_image text;

-- Cartao: URL do checkout hospedado do Asaas (os dados do cartao nunca
-- passam pelo nosso site — evita escopo PCI-DSS)
alter table public.orders
  add column if not exists checkout_url text;

-- Ultimo webhook recebido, pra auditoria e conciliacao
alter table public.orders
  add column if not exists gateway_payload jsonb;

-- payment_method: incluir debito (o check original so' tinha
-- pix/dinheiro/cartao_1x/cartao_2x/outro)
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'orders_payment_method_check'
  ) then
    alter table public.orders drop constraint orders_payment_method_check;
  end if;
end $$;

alter table public.orders
  add constraint orders_payment_method_check
  check (payment_method in ('pix','dinheiro','cartao_1x','cartao_2x','cartao_debito','outro'));

-- gateway_id ja' existia no schema.sql (previsto pra "Pagar.me/MP") e passa a
-- guardar o id da cobranca no Asaas. Indice pro webhook achar o pedido rapido.
create index if not exists idx_orders_gateway_id on public.orders(gateway_id);


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Confira no Table Editor:
--   app_settings -> 10 colunas novas (card_fee_percent, card_fee_percent_installment,
--                   card_fee_fixed, debit_fee_percent, debit_fee_fixed,
--                   pix_fee_fixed, pay_pix_enabled, pay_credit_enabled,
--                   pay_debit_enabled, surcharge_mode) e min_installment_value = 40
--   orders       -> 9 colunas novas (gateway, gateway_status, installments,
--                   amount_charged, surcharge_amount, pix_payload, pix_qr_image,
--                   checkout_url, gateway_payload)
-- ============================================================================
