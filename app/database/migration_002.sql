-- ============================================================================
-- FOR SCHOOL — Migração 002
-- ============================================================================
-- Adiciona:
--   1. Disponibilidade de produto por escola      (school_prices.available)
--   2. Custo de produção por produto              (products.production_cost)
--   3. Kits customizados por escola               (nova tabela school_kits)
--   4. Composição dos kits                        (nova tabela school_kit_items)
--   5. Rastreamento de item vindo de kit          (order_items.from_kit_id)
--   6. Custos fixos por escola                    (school_agreements.delivery_cost
--                                                  e material_cost_per_student)
--   7. Desativa os 3 produtos "kit" do seed       (não fazem mais sentido como
--                                                  produto global — kit agora é
--                                                  composição por escola)
--
-- Como executar:
--   1. SQL Editor do Supabase → New query
--   2. Cole TODO este arquivo
--   3. Run (ou Ctrl+Enter)
--   4. Esperado: "Success. No rows returned"
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Disponibilidade de produto por escola
-- ----------------------------------------------------------------------------
-- Por padrão, todo produto aparece em toda escola (available = true).
-- Pra esconder um produto numa escola específica, basta criar linha em
-- school_prices com available = false (mesmo sem mudar o preço).

alter table public.school_prices
  add column if not exists available boolean not null default true;


-- ----------------------------------------------------------------------------
-- 2. Custo de produção por produto
-- ----------------------------------------------------------------------------
-- Custo unitário do produto (papel + tinta + materiais + etc.).
-- Você decide o que entra nesse número. Fica zerado por enquanto.

alter table public.products
  add column if not exists production_cost numeric(10,2) not null default 0;


-- ----------------------------------------------------------------------------
-- 3. Kits customizados por escola
-- ----------------------------------------------------------------------------
-- 1 linha por (escola, tipo). Define o nome, descrição, foto, preço fechado
-- e disponibilidade do kit naquela escola.

create table if not exists public.school_kits (
  id uuid primary key default uuid_generate_v4(),
  school_id uuid not null references public.schools(id) on delete cascade,
  kit_type text not null check (kit_type in ('basico','inter','promo')),
  name text not null,
  description text,
  image_url text,
  price_with_promo numeric(10,2) not null default 0,
  price_without_promo numeric(10,2) not null default 0,
  available boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, kit_type)
);
create index if not exists idx_school_kits_school on public.school_kits(school_id);

drop trigger if exists trg_school_kits_updated on public.school_kits;
create trigger trg_school_kits_updated before update on public.school_kits
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- 4. Composição dos kits — qual avulso entra em qual kit, e quantos
-- ----------------------------------------------------------------------------

create table if not exists public.school_kit_items (
  id uuid primary key default uuid_generate_v4(),
  kit_id uuid not null references public.school_kits(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity int not null default 1 check (quantity > 0),
  created_at timestamptz not null default now(),
  unique (kit_id, product_id)
);
create index if not exists idx_school_kit_items_kit on public.school_kit_items(kit_id);


-- ----------------------------------------------------------------------------
-- 5. Rastreamento de item vindo de kit
-- ----------------------------------------------------------------------------
-- Quando o pai compra um kit, registramos os itens componentes em order_items
-- com unit_price = 0 (já está pago via kit), e marcamos from_kit_id pra
-- relatório de produção saber que veio de kit.
-- O item "kit" em si entra em order_items com product_id apontando pra um
-- registro especial OU como NULL — vou tratar isso na lógica do app.
-- Por hora, só adiciono a coluna.

alter table public.order_items
  add column if not exists from_kit_id uuid references public.school_kits(id) on delete set null;


-- ----------------------------------------------------------------------------
-- 6. Custos fixos por escola
-- ----------------------------------------------------------------------------
-- Adiciona em school_agreements (uma linha por escola já existente):
--   delivery_cost          — gasolina + tempo + frete de cada visita/entrega
--   material_cost_per_student — bilhete impresso, envelope, etc.

alter table public.school_agreements
  add column if not exists delivery_cost numeric(10,2) not null default 0;

alter table public.school_agreements
  add column if not exists material_cost_per_student numeric(10,2) not null default 0;


-- ----------------------------------------------------------------------------
-- 7. RLS das tabelas novas
-- ----------------------------------------------------------------------------

alter table public.school_kits enable row level security;
alter table public.school_kit_items enable row level security;

-- Admin acessa tudo
drop policy if exists admin_all_school_kits on public.school_kits;
create policy admin_all_school_kits on public.school_kits
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists admin_all_school_kit_items on public.school_kit_items;
create policy admin_all_school_kit_items on public.school_kit_items
  for all using (public.is_admin()) with check (public.is_admin());

-- Catálogo público (pai precisa ler pra montar a tela)
drop policy if exists public_read_school_kits on public.school_kits;
create policy public_read_school_kits on public.school_kits
  for select using (available = true);

drop policy if exists public_read_school_kit_items on public.school_kit_items;
create policy public_read_school_kit_items on public.school_kit_items
  for select using (true);


-- ----------------------------------------------------------------------------
-- 8. Desativa os 3 produtos "kit" do seed inicial
-- ----------------------------------------------------------------------------
-- Eles foram cadastrados no seed da migração 001 pra alinhar com o protótipo,
-- mas agora kits são por escola (school_kits) — não fazem mais sentido como
-- produto global. Marco como inativos pra não quebrar pedidos antigos
-- (se houver). Você pode deletar do painel depois se quiser.

update public.products
   set active = false
 where type in ('basico','inter','promo');


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Confira no Table Editor:
--   - school_kits           (tabela nova, vazia)
--   - school_kit_items      (tabela nova, vazia)
--   - school_prices         (coluna 'available' adicionada)
--   - products              (coluna 'production_cost' adicionada;
--                            3 produtos kit agora com active=false)
--   - order_items           (coluna 'from_kit_id' adicionada)
--   - school_agreements     (colunas 'delivery_cost' e
--                            'material_cost_per_student' adicionadas)
-- ============================================================================
