-- migration_029: valor liquido recebido e tarifa do gateway
--
-- Contexto:
--   O sistema mostrava so' o preco de tabela (total_amount). O Asaas desconta
--   a tarifa antes de creditar — PIX R$ 0,99 (promocional; R$ 1,99 depois de
--   03/12/2026), cartao 2,99% + R$ 0,49 — entao o que cai na conta e' menor,
--   e nao havia como bater com o extrato nem calcular lucro real.
--
--   O webhook do Asaas ja manda `netValue` (liquido) em todo evento de
--   pagamento. Passamos a guardar. A tarifa sai da diferenca, ou seja, vem
--   do proprio gateway — nao de conta nossa. Isso tambem serve de conferencia:
--   se a taxa configurada em Configuracoes estiver errada, aparece aqui.
--
-- Rodar no SQL Editor do Supabase.

-- Quanto realmente caiu na conta Asaas (liquido, ja sem a tarifa)
alter table public.orders
  add column if not exists net_amount numeric(10,2);

-- Tarifa cobrada pelo gateway = amount_charged - net_amount
alter table public.orders
  add column if not exists gateway_fee numeric(10,2);


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Confira no Table Editor:
--   orders -> 2 colunas novas (net_amount, gateway_fee)
--
-- Pedidos antigos ficam com os campos vazios — so' os pagos a partir de agora
-- terao o liquido preenchido, porque o dado vem do webhook.
-- ============================================================================
