-- migration_059: pedidos de irmãos pagos juntos, com desconto configurável
--
-- Contexto:
--   Pedido do Daniel: quando dois filhos da mesma família compram no mesmo
--   projeto, cada um continua com o PRÓPRIO pedido (é dele que sai a ficha,
--   o produto certo, tudo) — mas o pagamento pode virar UM SÓ, com desconto.
--
--   Etapa 1 (esta migração + o código que a usa): PIX à vista e cartão à
--   vista combinados. Parcelado (cartão Nx e PIX Woovi Nx) fica pra uma
--   Etapa 2, depois de validar isto com dinheiro real — mesmo padrão que já
--   foi seguido pro PIX automático (migration_057) e pro PIX parcelado
--   (migration_058): validar o caminho simples antes de complicar.
--
--   Só funciona entre irmãos do MESMO projeto — projetos diferentes podem
--   ter configuração de pagamento (gateway, PIX manual/automático) diferente
--   entre si, então combinar entre eles não é seguro.
--
-- O que muda:
--   projects.sibling_discount_mode/value -> desconto configurável por
--     projeto: 'fixed' (R$ fixo) ou 'percent' (%), em branco = desligado
--     (nenhum projeto existente ganha desconto sozinho).
--   orders.payment_group_id -> pedidos que dividem o MESMO id foram
--     cobrados juntos, numa cobrança só. Um deles carrega os campos de
--     cobrança de verdade (gateway/gateway_id/pix_payload/etc.) — os dois
--     ganham os MESMOS valores nesses campos na criação (é isso que faz a
--     tela de pagamento de qualquer um dos dois já funcionar sem mexer em
--     renderPaymentMethods()). Quando o webhook confirma a cobrança, marca
--     TODOS os pedidos com o mesmo payment_group_id como pagos de uma vez.
--
-- Rodar no SQL Editor do Supabase, projeto de produção. Nada muda sozinho:
-- as colunas nascem vazias/nulas, nenhum pedido ou projeto existente é
-- afetado até o Daniel configurar o desconto num projeto.

alter table public.projects
  add column if not exists sibling_discount_mode text
    check (sibling_discount_mode is null or sibling_discount_mode in ('fixed','percent')),
  add column if not exists sibling_discount_value numeric;

alter table public.orders
  add column if not exists payment_group_id uuid;

create index if not exists idx_orders_payment_group
  on public.orders(payment_group_id) where payment_group_id is not null;

-- ============================================================================
-- FIM. Nada muda de comportamento sozinho: sibling_discount_mode nasce nulo
-- em todo projeto (desconto desligado) e payment_group_id nasce nulo em todo
-- pedido. Só passa a valer quando o Daniel configurar o desconto num projeto
-- específico em Admin -> Projetos -> aba Dados -> Pagamento.
-- ============================================================================
