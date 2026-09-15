-- migration_043: separar "o cartao passou" de "o dinheiro caiu"
--
-- O problema (visto nos dados reais de 15/09/2026):
--   No Asaas, CONFIRMED e RECEIVED NAO sao a mesma coisa:
--     CONFIRMED -> pagamento efetuado, saldo AINDA NAO disponivel
--     RECEIVED  -> dinheiro na conta
--   No PIX os dois acontecem no mesmo instante. No cartao nao: CONFIRMED vem
--   na hora e RECEIVED so' na liquidacao.
--
--   O webhook tratava os dois como "pago" e pronto. Resultado: NENHUM pedido
--   de cartao desta base jamais chegou a RECEIVED, e mesmo assim todos
--   aparecem como pagos — com previsao de credito em D+32 (a' vista) e D+64
--   (2x). Nao da' pra conferir extrato assim, e pagamento que o banco ainda
--   vai perguntar ao cliente aparece como dinheiro garantido.
--
-- O que estas colunas guardam:
--   credit_expected_date -> quando o Asaas preve creditar o valor TODO
--                           (no parcelado, a data da ultima parcela a cair)
--   credited_at          -> quando caiu de verdade. So' e' preenchida quando
--                           TODAS as parcelas estao em RECEIVED.
--
--   Regra pra ler: pago com credited_at = dinheiro na conta.
--                  pago sem credited_at = passou, mas ainda nao caiu.
--
--   ⚠️ Nao use creditDate do Asaas como prova de que caiu: ele vem preenchido
--   ja' em CONFIRMED, com a data PROGRAMADA. Quem prova e' o status.
--
-- Rodar no SQL Editor do Supabase.

alter table public.orders add column if not exists credit_expected_date date;
alter table public.orders add column if not exists credited_at          date;

comment on column public.orders.credit_expected_date is
  'Previsao do Asaas pra o valor inteiro cair (ultima parcela). Null = sem previsao.';
comment on column public.orders.credited_at is
  'Quando o dinheiro caiu de verdade (todas as parcelas RECEIVED). Null = ainda nao caiu.';

-- ============================================================================
-- FIM. Duas colunas novas, vazias. Nada existente e' alterado.
--
-- Resultado esperado: "Success. No rows returned".
--
-- Efeito no primeiro uso: os pedidos ANTIGOS ficam sem essas datas, porque
-- elas so' sao preenchidas quando um webhook novo chega. Pra tela isso
-- aparece como "sem previsao" — nao como "nao caiu". Os pedidos novos ja'
-- nascem certos, e os antigos se corrigem sozinhos quando o Asaas mandar o
-- PAYMENT_RECEIVED da liquidacao.
-- ============================================================================
