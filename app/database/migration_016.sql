-- ============================================================================
-- FOR SCHOOL — Migração 016
-- ============================================================================
-- 1. Endereço nas escolas
-- 2. Tabela collaborators (fotógrafos e auxiliares)
-- 3. Tabela project_collaborators (vínculo colaborador ↔ projeto/sessão)
-- 4. Comissão por cabeça em vendor_schools
-- 5. Tabela order_kits (múltiplos kits por pedido)
--
-- Como executar:
--   SQL Editor do Supabase → New query → Cole → Run
--   Esperado: "Success. No rows returned"
-- ============================================================================


-- ============================================================================
-- 1. Endereço nas escolas
-- ============================================================================

alter table public.schools
  add column if not exists endereco   text,
  add column if not exists complemento text,
  add column if not exists bairro     text,
  add column if not exists cidade     text,
  add column if not exists estado     char(2),
  add column if not exists cep        varchar(9);


-- ============================================================================
-- 2. Colaboradores (fotógrafos, auxiliares, etc.)
-- ============================================================================

create table if not exists public.collaborators (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  whatsapp    text,
  pix_key     text,
  pix_key_type text,   -- cpf | cnpj | email | phone | random
  pix_bank    text,
  role        text not null default 'fotografo',  -- fotografo | auxiliar | outro
  notes       text,
  active      boolean not null default true,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- RLS
alter table public.collaborators enable row level security;

create policy "Admin acessa colaboradores" on public.collaborators
  for all using (public.is_admin());


-- ============================================================================
-- 3. Vínculo colaborador ↔ projeto/sessão
-- ============================================================================

create table if not exists public.project_collaborators (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid references public.projects(id) on delete cascade not null,
  collaborator_id   uuid references public.collaborators(id) on delete cascade not null,
  session_id        uuid references public.project_sessions(id) on delete set null,
  service_value     numeric(10,2),   -- valor combinado para esse projeto/sessão
  work_date         date,
  notes             text,
  created_at        timestamptz default now()
);

create index if not exists idx_proj_collab_project  on public.project_collaborators(project_id);
create index if not exists idx_proj_collab_collab   on public.project_collaborators(collaborator_id);

-- RLS
alter table public.project_collaborators enable row level security;

create policy "Admin acessa project_collaborators" on public.project_collaborators
  for all using (public.is_admin());


-- ============================================================================
-- 4. Comissão por cabeça em vendor_schools
-- ============================================================================

alter table public.vendor_schools
  add column if not exists commission_mode     text not null default 'percent',
  -- 'percent'   → usa commission_rate (%) já existente
  -- 'per_head'  → usa commission_per_head (R$ por pedido pago)
  add column if not exists commission_per_head numeric(10,2);


-- ============================================================================
-- 5. order_kits — múltiplos kits por pedido
-- ============================================================================

create table if not exists public.order_kits (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid references public.orders(id) on delete cascade not null,
  kit_id      uuid references public.school_kits(id) on delete restrict not null,
  quantity    int not null default 1 check (quantity > 0),
  unit_price  numeric(10,2) not null,
  created_at  timestamptz default now()
);

create index if not exists idx_order_kits_order on public.order_kits(order_id);

-- RLS
alter table public.order_kits enable row level security;

create policy "Admin vê order_kits" on public.order_kits
  for all using (public.is_admin());

create policy "Pai vê seus order_kits" on public.order_kits
  for select using (
    exists (
      select 1 from public.orders o
      where o.id = order_id
        and o.user_id = auth.uid()
    )
  );


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Conferir no Table Editor:
--   - schools      → colunas endereco, complemento, bairro, cidade, estado, cep
--   - collaborators → nova tabela
--   - project_collaborators → nova tabela
--   - vendor_schools → colunas commission_mode, commission_per_head
--   - order_kits   → nova tabela
-- ============================================================================
