-- migration_051: personalizar produto avulso por projeto (nome, descricao,
-- foto e variacoes), sem mexer no produto global nem nos outros projetos
--
-- Contexto:
--   Caso real: a Unidade II usa os mesmos produtos avulsos da Unidade I
--   (mesmo catalogo global), mas quer nome/descricao/foto e ate variacoes
--   diferentes em alguns deles. Duplicar o produto pra isso quebraria
--   relatorios/Analise de Produtos (contariam como produtos diferentes) e
--   duplicaria manutencao pra sempre. Aqui, o produto continua sendo UM so'
--   — so' a "aparencia" dele muda por projeto, e so' pra quem personalizou.
--
-- O que muda:
--   1. school_prices ganha name/description/image_url — em branco, o
--      catalogo continua usando o valor do produto global
--      (products.name/description/image_url). Preenchido, vale so' pra
--      aquele projeto (ou aquela escola, se for override sem projeto).
--   2. school_prices.variants_overridden (boolean, default false) — quando
--      ligado, o catalogo usa SO' as variacoes de school_price_variants pra
--      esse produto nesse projeto (mesmo que a lista esteja vazia de
--      proposito — "esse projeto nao tem variacao nenhuma desse produto").
--      Desligado (o padrao, e o que todo projeto ja tem hoje), continua
--      usando product_variants do produto global, como sempre foi.
--   3. Tabela nova school_price_variants — mesma forma de product_variants,
--      mas pertence a UM school_prices (um produto dentro de UM projeto ou
--      escola especifico), nunca ao produto global.
--
-- Rodar no SQL Editor do Supabase.

alter table public.school_prices
  add column if not exists name text,
  add column if not exists description text,
  add column if not exists image_url text,
  add column if not exists variants_overridden boolean not null default false;

create table if not exists public.school_price_variants (
  id                    uuid primary key default gen_random_uuid(),
  school_price_id       uuid not null references public.school_prices(id) on delete cascade,
  name                  text not null,
  image_url             text,
  price_with_promo      numeric(10,2),
  price_without_promo   numeric(10,2),
  photo_theme           text,
  sort_order            integer not null default 0,
  active                boolean not null default true,
  created_at            timestamptz not null default now()
);
create index if not exists idx_school_price_variants_sp on public.school_price_variants(school_price_id);

alter table public.school_price_variants enable row level security;

-- Mesmo padrao de product_variants: admin mexe em tudo, catalogo e' publico.
drop policy if exists admin_all_school_price_variants on public.school_price_variants;
create policy admin_all_school_price_variants on public.school_price_variants
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists public_read_school_price_variants on public.school_price_variants;
create policy public_read_school_price_variants on public.school_price_variants
  for select using (active = true);

-- ============================================================================
-- FIM. Nenhum produto ou projeto existente muda de comportamento sozinho —
-- as colunas novas nascem em branco/desligadas, e a tabela nova comeca vazia.
-- Confira em Admin > Projetos > abrir um projeto > aba "Kits & Avulsos":
-- cada avulso ganha um botao "✏️ Personalizar pra este projeto".
-- ============================================================================
