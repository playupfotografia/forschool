-- migration_060: responsável pode cancelar o próprio pedido pendente
--
-- Contexto (24/09/2026):
--   O pedido pendente é o carrinho do portal. Se o responsável desistia, não
--   tinha como sair: o aviso amarelo "você tem o pedido X aguardando
--   pagamento" ficava pra sempre, e o carrinho vazio não pode ser finalizado.
--   Agora ele pode cancelar pela Minha Área (ou pelo próprio aviso amarelo).
--
--   O pedido NÃO é apagado — vira "cancelado", com quem cancelou e quando.
--   É isso que deixa o histórico visível no admin: se ele cancelar o P0138 e
--   depois fizer e pagar o P0140, Alunos & Pedidos mostra o P0140 e avisa que
--   existiu um cancelado antes.
--
-- O que muda:
--   orders.cancelled_at  -> quando foi cancelado (vazio = nunca foi, ou foi
--                           reativado depois).
--   orders.cancelled_by  -> 'responsavel' ou 'admin'.
--   pix_installments.status aceita 'cancelada' — pedido parcelado no PIX
--     cancelado antes de qualquer parcela paga tem as cobranças das parcelas
--     canceladas na Woovi. Sem esse status, o robô diário
--     (cron-parcelas-atrasadas.js) continuaria mandando lembrete e gerando
--     "2ª tentativa" pra um pedido que ninguém quer mais.
--
-- Rodar no SQL Editor do Supabase, ANTES do push do código que usa estas
-- colunas (o admin e a função de cancelar leem cancelled_at/cancelled_by —
-- sem elas, a tela Alunos & Pedidos quebra).

alter table public.orders
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by text
    check (cancelled_by is null or cancelled_by in ('responsavel','admin'));

alter table public.pix_installments drop constraint if exists pix_installments_status_check;
alter table public.pix_installments
  add constraint pix_installments_status_check
  check (status in ('scheduled','active','paid','atrasada','cancelada'));

-- ============================================================================
-- FIM. Nada muda sozinho: as colunas nascem vazias. Pedidos já cancelados
-- antes desta migração continuam cancelados, só sem "quem/quando".
-- ============================================================================
