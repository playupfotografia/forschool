-- migration_034: variacoes de produto (cor/tema) — Etapa 1 (avulsos)
--
-- Contexto:
--   Produto unico com opcoes que o pai escolhe antes de comprar — ex: um
--   quadro em 3 cores diferentes, ou um produto com 2 temas de arte. Cada
--   opcao pode ter foto e preco proprios.
--
--   So' avulsos por enquanto (kits ficam pra depois) e SEM moldura por
--   variacao ainda (isso e' a Etapa 2, quando mexer na tela de Montagem e
--   no organizador de fotos). Aqui e' so' cadastro + escolha no portal +
--   preco certo no pedido.
--
-- Rodar no SQL Editor do Supabase.

-- ----------------------------------------------------------------------------
-- 1. Tabela nova — cada linha e' uma opcao dentro de um produto
-- ----------------------------------------------------------------------------

create table if not exists public.product_variants (
  id                    uuid primary key default gen_random_uuid(),
  product_id            uuid not null references public.products(id) on delete cascade,
  name                  text not null,
  image_url             text,
  price_with_promo      numeric(10,2) not null default 0,
  price_without_promo   numeric(10,2) not null default 0,
  sort_order            integer not null default 0,
  active                boolean not null default true,
  created_at            timestamptz not null default now()
);
create index if not exists idx_product_variants_product on public.product_variants(product_id);

alter table public.product_variants enable row level security;

-- Mesmo padrao de products: admin mexe em tudo, catalogo e' publico.
drop policy if exists admin_all_product_variants on public.product_variants;
create policy admin_all_product_variants on public.product_variants
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists public_read_product_variants on public.product_variants;
create policy public_read_product_variants on public.product_variants
  for select using (active = true);


-- ----------------------------------------------------------------------------
-- 2. order_items guarda qual variacao foi escolhida
-- ----------------------------------------------------------------------------
-- variant_id aponta pra variacao (pode virar null se ela for apagada depois —
-- "on delete set null", nunca apaga o pedido). variant_name e' uma FOTOGRAFIA
-- do nome na hora da compra: mesmo se a variacao for renomeada ou removida
-- depois, o pedido antigo continua mostrando certo o que foi comprado —
-- mesmo principio ja usado pra nunca deixar historico mudar sozinho.

alter table public.order_items
  add column if not exists variant_id uuid references public.product_variants(id) on delete set null;

alter table public.order_items
  add column if not exists variant_name text;


-- ============================================================================
-- FIM. Nada em products, orders, order_items (linhas existentes), students ou
-- pagamentos e' alterado — so' coluna nova e tabela nova.
--
-- Resultado esperado: "Success. No rows returned"
-- Confira no Table Editor: product_variants (tabela nova, vazia) e
-- order_items com as 2 colunas novas.
-- ============================================================================
