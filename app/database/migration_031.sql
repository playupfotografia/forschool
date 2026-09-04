-- migration_031: entrega individual para pedidos de ultima hora
--
-- Contexto:
--   As fotos vao em lote pra escola numa data marcada (projects.delivery_date).
--   Pedido feito em cima da hora nao entra nesse lote — precisa de entrega
--   individual (motoboy) ou retirada no estudio.
--
--   O corte e' N dias ANTES da entrega, nao depois: producao leva tempo, entao
--   um pedido feito 2 dias antes ja nao alcanca o lote. Padrao 5 dias.
--
--   A taxa nasce em R$ 35,00 — referencia de moto pra regiao em 03/09/2026 era
--   R$ 34,11. Ajustavel por projeto: escola mais longe, taxa maior.
--
-- Rodar no SQL Editor do Supabase.

-- ----------------------------------------------------------------------------
-- 1. Projeto: regra de entrega
-- ----------------------------------------------------------------------------

alter table public.projects
  add column if not exists delivery_fee numeric(10,2) not null default 35;

-- Quantos dias ANTES da entrega o pedido deixa de entrar no lote da escola
alter table public.projects
  add column if not exists delivery_cutoff_days int not null default 5;

-- Oferecer retirada gratuita no estudio como alternativa ao motoboy
alter table public.projects
  add column if not exists pickup_enabled boolean not null default true;


-- ----------------------------------------------------------------------------
-- 2. Pedido: como vai ser entregue
-- ----------------------------------------------------------------------------

-- 'escola' = vai no lote (padrao) | 'retirada' = estudio | 'motoboy' = entrega
alter table public.orders
  add column if not exists delivery_method text not null default 'escola';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_delivery_method_check') then
    alter table public.orders
      add constraint orders_delivery_method_check
      check (delivery_method in ('escola','retirada','motoboy'));
  end if;
end $$;

alter table public.orders
  add column if not exists delivery_fee numeric(10,2) not null default 0;

-- Endereco so' e' pedido de quem escolhe motoboy
alter table public.orders
  add column if not exists delivery_address text;


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Confira no Table Editor:
--   projects -> 3 colunas novas (delivery_fee, delivery_cutoff_days, pickup_enabled)
--   orders   -> 3 colunas novas (delivery_method, delivery_fee, delivery_address)
--
-- Pedidos antigos ficam como 'escola' com taxa zero, que e' o comportamento
-- que sempre existiu.
-- ============================================================================
