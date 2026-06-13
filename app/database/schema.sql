-- ============================================================================
-- FOR SCHOOL — Schema inicial do banco
-- ============================================================================
-- Cria todas as tabelas, índices e políticas de segurança (RLS).
-- Rode UMA VEZ no SQL Editor do Supabase.
--
-- Como executar:
--   1. No painel do Supabase, abra "SQL Editor" no menu esquerdo
--   2. Clique em "New query"
--   3. Cole TODO este arquivo
--   4. Aperte "Run" (ou Ctrl+Enter)
--   5. Deve aparecer "Success. No rows returned" — pronto.
--
-- Se der erro, copia a mensagem e me manda — eu ajusto.
-- ============================================================================


-- ============================================================================
-- 1. EXTENSÕES E FUNÇÕES AUXILIARES
-- ============================================================================

-- UUIDs são padrão moderno de ID (mais seguros que serial sequencial)
create extension if not exists "uuid-ossp";

-- Função helper: detecta se o usuário logado é admin
-- (admin é marcado em app_metadata.role no painel do Supabase Auth)
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin',
    false
  );
$$;

-- Função helper: trigger pra atualizar updated_at automaticamente
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ============================================================================
-- 2. TABELAS — na ordem das dependências
-- ============================================================================

-- ----------------------------------------------------------------------------
-- USERS (estende auth.users do Supabase com dados extras)
-- ----------------------------------------------------------------------------
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  cpf text unique,
  phone text,
  email text,
  role text not null default 'parent' check (role in ('admin','parent')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_users_cpf on public.users(cpf);
create index idx_users_role on public.users(role);
create trigger trg_users_updated before update on public.users
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- SCHOOLS — uma linha por escola parceira
-- ----------------------------------------------------------------------------
create table public.schools (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  slug text unique not null,             -- ex: 'sena-miranda'  → forschool.playupfotografia.com.br/sena-miranda
  cnpj text,
  phone text,
  logo_url text,
  photo_date date,                       -- data das fotos
  order_deadline date,                   -- prazo final pra fazer pedidos
  delivery_date date,                    -- data de entrega
  wpp_number text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_schools_slug on public.schools(slug);
create index idx_schools_active on public.schools(active);
create trigger trg_schools_updated before update on public.schools
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- SCHOOL_YEARS — anos da escola (G1, G2, 1º Ano, etc.)
-- ----------------------------------------------------------------------------
create table public.school_years (
  id uuid primary key default uuid_generate_v4(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (school_id, name)
);
create index idx_school_years_school on public.school_years(school_id);


-- ----------------------------------------------------------------------------
-- SCHOOL_CLASSES — turmas de cada ano (A, B, C)
-- ----------------------------------------------------------------------------
create table public.school_classes (
  id uuid primary key default uuid_generate_v4(),
  year_id uuid not null references public.school_years(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (year_id, name)
);
create index idx_school_classes_year on public.school_classes(year_id);


-- ----------------------------------------------------------------------------
-- PRODUCTS — catálogo global (kits e avulsos)
-- ----------------------------------------------------------------------------
create table public.products (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  type text not null check (type in ('basico','inter','promo','avulso')),
  description text,
  image_url text,
  base_price_with_promo numeric(10,2) not null default 0,
  base_price_without_promo numeric(10,2) not null default 0,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_products_type on public.products(type);
create index idx_products_active on public.products(active);
create trigger trg_products_updated before update on public.products
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- SCHOOL_PRICES — sobrescreve preço base por escola (opcional)
-- ----------------------------------------------------------------------------
create table public.school_prices (
  id uuid primary key default uuid_generate_v4(),
  school_id uuid not null references public.schools(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  price_with_promo numeric(10,2) not null,
  price_without_promo numeric(10,2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, product_id)
);
create index idx_school_prices_school on public.school_prices(school_id);
create trigger trg_school_prices_updated before update on public.school_prices
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- STUDENTS — alunos (vinculados ao responsável e à turma)
-- ----------------------------------------------------------------------------
create table public.students (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  birth_date date,
  user_id uuid references public.users(id) on delete set null,    -- responsável (NULL se cadastrado pelo admin sem responsável)
  class_id uuid references public.school_classes(id) on delete set null,
  school_id uuid not null references public.schools(id) on delete cascade,
  photo_seq_number integer,                                       -- número da ficha de identificação
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_students_school on public.students(school_id);
create index idx_students_user on public.students(user_id);
create index idx_students_class on public.students(class_id);
create trigger trg_students_updated before update on public.students
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- ORDERS — pedido (cabeçalho)
-- ----------------------------------------------------------------------------
create table public.orders (
  id uuid primary key default uuid_generate_v4(),
  order_number text unique,                                       -- ex: P0001, preenchido por trigger
  student_id uuid not null references public.students(id) on delete restrict,
  user_id uuid references public.users(id) on delete set null,   -- responsável que fez o pedido
  school_id uuid not null references public.schools(id) on delete restrict,
  kit_type text check (kit_type in ('basico','inter','promo')),  -- kit escolhido
  total_amount numeric(10,2) not null default 0,
  payment_method text check (payment_method in ('pix','dinheiro','cartao_1x','cartao_2x','outro')),
  payment_status text not null default 'pending' check (payment_status in ('pending','paid','refunded','cancelled')),
  payment_proof_url text,                                         -- comprovante PIX subido pelo pai
  gateway_id text,                                                -- futuro: ID de transação Pagar.me/MP
  paid_at timestamptz,
  source text not null default 'parent' check (source in ('parent','admin_manual')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_orders_student on public.orders(student_id);
create index idx_orders_user on public.orders(user_id);
create index idx_orders_school on public.orders(school_id);
create index idx_orders_status on public.orders(payment_status);
create trigger trg_orders_updated before update on public.orders
  for each row execute function public.set_updated_at();

-- Trigger pra gerar order_number sequencial (P0001, P0002, ...)
create sequence if not exists orders_seq start 1;
create or replace function public.set_order_number()
returns trigger language plpgsql as $$
begin
  if new.order_number is null then
    new.order_number := 'P' || lpad(nextval('orders_seq')::text, 4, '0');
  end if;
  return new;
end;
$$;
create trigger trg_orders_number before insert on public.orders
  for each row execute function public.set_order_number();


-- ----------------------------------------------------------------------------
-- ORDER_ITEMS — itens do pedido (avulsos e kit)
-- ----------------------------------------------------------------------------
create table public.order_items (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity integer not null default 1,
  unit_price numeric(10,2) not null,
  discount_applied boolean not null default false,                -- true se preço promo foi aplicado
  created_at timestamptz not null default now()
);
create index idx_order_items_order on public.order_items(order_id);


-- ----------------------------------------------------------------------------
-- VENDORS — vendedores externos
-- ----------------------------------------------------------------------------
create table public.vendors (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  phone text,
  email text,
  commission_type text not null default 'pct' check (commission_type in ('pct','fixed')),
  commission_value numeric(10,2) not null default 0,              -- % ou R$ por aluno
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_vendors_updated before update on public.vendors
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- VENDOR_SCHOOLS — relação N:N entre vendedor e escola
-- ----------------------------------------------------------------------------
create table public.vendor_schools (
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  school_id uuid not null references public.schools(id) on delete cascade,
  commission_status text not null default 'pending' check (commission_status in ('pending','paid')),
  paid_at timestamptz,
  notes text,
  primary key (vendor_id, school_id)
);


-- ----------------------------------------------------------------------------
-- SCHOOL_AGREEMENTS — acordo financeiro com a escola
-- ----------------------------------------------------------------------------
create table public.school_agreements (
  school_id uuid primary key references public.schools(id) on delete cascade,
  contact_name text,
  contact_phone text,
  contact_email text,
  repayment_type text not null default 'nenhum' check (repayment_type in ('nenhum','pct','fixo')),
  repayment_value numeric(10,2) not null default 0,
  repayment_status text not null default 'pending' check (repayment_status in ('pending','paid')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_school_agreements_updated before update on public.school_agreements
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- SCHOOL_HISTORY — histórico de anos anteriores por escola
-- ----------------------------------------------------------------------------
create table public.school_history (
  id uuid primary key default uuid_generate_v4(),
  school_id uuid not null references public.schools(id) on delete cascade,
  year integer not null,
  student_count integer not null default 0,
  total_revenue numeric(10,2) not null default 0,
  notes text,
  created_at timestamptz not null default now()
);
create index idx_school_history_school on public.school_history(school_id);


-- ============================================================================
-- 3. ROW LEVEL SECURITY (RLS) — quem pode ler/escrever o quê
-- ============================================================================

-- Ativa RLS em todas as tabelas
alter table public.users enable row level security;
alter table public.schools enable row level security;
alter table public.school_years enable row level security;
alter table public.school_classes enable row level security;
alter table public.products enable row level security;
alter table public.school_prices enable row level security;
alter table public.students enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.vendors enable row level security;
alter table public.vendor_schools enable row level security;
alter table public.school_agreements enable row level security;
alter table public.school_history enable row level security;


-- ----------------------------------------------------------------------------
-- ADMIN — acesso total em tudo (via is_admin())
-- ----------------------------------------------------------------------------
create policy admin_all_users        on public.users               for all using (public.is_admin()) with check (public.is_admin());
create policy admin_all_schools      on public.schools             for all using (public.is_admin()) with check (public.is_admin());
create policy admin_all_years        on public.school_years        for all using (public.is_admin()) with check (public.is_admin());
create policy admin_all_classes      on public.school_classes      for all using (public.is_admin()) with check (public.is_admin());
create policy admin_all_products     on public.products            for all using (public.is_admin()) with check (public.is_admin());
create policy admin_all_prices       on public.school_prices       for all using (public.is_admin()) with check (public.is_admin());
create policy admin_all_students     on public.students            for all using (public.is_admin()) with check (public.is_admin());
create policy admin_all_orders       on public.orders              for all using (public.is_admin()) with check (public.is_admin());
create policy admin_all_items        on public.order_items         for all using (public.is_admin()) with check (public.is_admin());
create policy admin_all_vendors      on public.vendors             for all using (public.is_admin()) with check (public.is_admin());
create policy admin_all_vendor_sch   on public.vendor_schools      for all using (public.is_admin()) with check (public.is_admin());
create policy admin_all_agreements   on public.school_agreements   for all using (public.is_admin()) with check (public.is_admin());
create policy admin_all_history      on public.school_history      for all using (public.is_admin()) with check (public.is_admin());


-- ----------------------------------------------------------------------------
-- PUBLIC READ — catálogo é público (qualquer um pode ler pra montar a tela)
-- ----------------------------------------------------------------------------
create policy public_read_schools    on public.schools             for select using (active = true);
create policy public_read_years      on public.school_years        for select using (true);
create policy public_read_classes    on public.school_classes      for select using (true);
create policy public_read_products   on public.products            for select using (active = true);
create policy public_read_prices     on public.school_prices       for select using (true);


-- ----------------------------------------------------------------------------
-- PARENT — pai logado: vê e cria os próprios dados
-- ----------------------------------------------------------------------------

-- Pai vê e atualiza o próprio perfil
create policy parent_own_user        on public.users               for select using (auth.uid() = id);
create policy parent_update_user     on public.users               for update using (auth.uid() = id);

-- Pai vê e cria seus próprios alunos
create policy parent_own_students    on public.students            for select using (auth.uid() = user_id);
create policy parent_insert_students on public.students            for insert with check (auth.uid() = user_id);
create policy parent_update_students on public.students            for update using (auth.uid() = user_id);

-- Pai vê e cria seus próprios pedidos
create policy parent_own_orders      on public.orders              for select using (auth.uid() = user_id);
create policy parent_insert_orders   on public.orders              for insert with check (auth.uid() = user_id);

-- Pai vê itens dos próprios pedidos
create policy parent_own_items       on public.order_items         for select using (
  exists (select 1 from public.orders o where o.id = order_id and o.user_id = auth.uid())
);
create policy parent_insert_items    on public.order_items         for insert with check (
  exists (select 1 from public.orders o where o.id = order_id and o.user_id = auth.uid())
);


-- ----------------------------------------------------------------------------
-- ANON — visitante sem login: precisa poder se cadastrar
-- (a criação de auth.users é feita pelo Supabase Auth, não direto aqui.
--  o INSERT em public.users acontece após o sign-up via trigger ou client.)
-- ----------------------------------------------------------------------------

-- Sem políticas extras aqui — Supabase Auth gerencia o sign-up.
-- A criação do registro em public.users vai acontecer via trigger
-- após o sign-up em auth.users (definido abaixo).


-- ============================================================================
-- 4. TRIGGER: criar perfil em public.users automaticamente após sign-up
-- ============================================================================
-- Quando alguém se cadastra (Supabase Auth cria linha em auth.users),
-- inserimos a linha correspondente em public.users com os metadados.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, name, cpf, phone, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', ''),
    new.raw_user_meta_data ->> 'cpf',
    new.raw_user_meta_data ->> 'phone',
    new.email,
    coalesce(new.raw_app_meta_data ->> 'role', 'parent')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============================================================================
-- 5. SEED INICIAL — produtos padrão da Play Up
-- ============================================================================
-- Cadastra os kits e avulsos básicos. Você pode editar depois no painel.

insert into public.products (name, type, description, image_url, base_price_with_promo, base_price_without_promo, sort_order) values
  ('Kit Básico',           'basico', '2 fotos individuais 10x15 cm em papel fotográfico',                                                  '📷', 49.90,  49.90, 1),
  ('Kit Intermediário',    'inter',  '1 foto 10x15 + 6 fotos 3x4 + 1 foto de turma 15x21',                                                  '🖼️', 79.90,  79.90, 2),
  ('Kit Promocional',      'promo',  '2 fotos 10x15 + foto de turma + 3x4 + calendário + marcador + porta-retratos',                       '🎁', 119.90, 119.90, 3),
  ('6 fotos 3x4',          'avulso', '6 fotos 3x4 em papel fotográfico',                                                                    '📸', 25.50,  34.00, 10),
  ('Foto 10x15',           'avulso', 'Foto individual 10x15 colorida',                                                                       '🖼️', 25.50,  34.00, 11),
  ('Foto 10x15 P&B',       'avulso', 'Foto individual 10x15 em preto e branco',                                                              '⚫', 25.50,  34.00, 12),
  ('Foto 15x21',           'avulso', 'Foto individual 15x21',                                                                                 '🖼️', 28.00,  38.00, 13),
  ('Foto 20x25',           'avulso', 'Foto ampliada 20x25',                                                                                   '🖼️', 38.00,  49.00, 14),
  ('Foto Turma',           'avulso', 'Foto coletiva da turma 15x21',                                                                          '👥', 28.00,  38.00, 15),
  ('Calendário 15x21',     'avulso', 'Calendário personalizado com foto e ímã',                                                              '📅', 30.00,  40.00, 16),
  ('Marcador de páginas',  'avulso', 'Marcador de páginas personalizado com foto',                                                            '🔖', 17.25,  23.00, 17),
  ('Chaveiro Acrílico',    'avulso', 'Chaveiro acrílico personalizado com foto 3x4',                                                         '🔑', 17.25,  20.00, 18),
  ('Caneca Porcelana',     'avulso', 'Caneca branca de porcelana personalizada com foto do aluno',                                            '☕', 44.90,  59.90, 19),
  ('Porta-retratos c/foto','avulso', 'Porta-retratos de papel triplex 10x15 com foto incluída',                                              '🪞', 35.00,  45.00, 20),
  ('Porta-retratos s/foto','avulso', 'Porta-retratos vazio (para usar com foto a parte)',                                                    '🪞', 10.00,  12.00, 21);


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
-- ============================================================================
