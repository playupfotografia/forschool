-- ============================================================================
-- FOR SCHOOL — Migração 003
-- ============================================================================
-- Ajustes baseados em feedback real de uso:
--
--   1. KITS têm UM PREÇO SÓ (preço fechado), não dois.
--      O preço promocional só existe em AVULSOS — pra dar desconto quando
--      o pai compra o Kit Promocional/Completo junto.
--
--   2. ESCOLA TEM VÁRIOS CONTATOS, não 1 só.
--      Ex: Diretor, Coord. Infantil, Coord. Fund I, Coord. Fund II,
--      Coord. Médio — cada um com WhatsApp diferente.
--      Criamos tabela `school_contacts` (N:1 com schools).
--
--   3. Mantém school_prices.available, production_cost, custos fixos etc.
--      (tudo da migração 002 continua válido).
--
-- Como executar:
--   1. SQL Editor do Supabase → New query
--   2. Cole TODO este arquivo
--   3. Run (ou Ctrl+Enter)
--   4. Esperado: "Success. No rows returned"
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. KITS — preço único (em vez de c/promo + sem promo)
-- ----------------------------------------------------------------------------

-- Adiciona nova coluna `price`
alter table public.school_kits
  add column if not exists price numeric(10,2) not null default 0;

-- Migra dados existentes: usa o maior dos dois antigos (geralmente o sem promo)
update public.school_kits
   set price = greatest(coalesce(price_with_promo, 0), coalesce(price_without_promo, 0))
 where price = 0
   and (coalesce(price_with_promo, 0) > 0 or coalesce(price_without_promo, 0) > 0);

-- Remove os 2 campos antigos
alter table public.school_kits drop column if exists price_with_promo;
alter table public.school_kits drop column if exists price_without_promo;


-- ----------------------------------------------------------------------------
-- 2. CONTATOS MÚLTIPLOS POR ESCOLA
-- ----------------------------------------------------------------------------

create table if not exists public.school_contacts (
  id uuid primary key default uuid_generate_v4(),
  school_id uuid not null references public.schools(id) on delete cascade,
  role text,                       -- "Diretor", "Coord. Infantil", "Secretaria", etc.
  name text not null,
  phone text,
  email text,
  notes text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_school_contacts_school on public.school_contacts(school_id);

alter table public.school_contacts enable row level security;

drop policy if exists admin_all_school_contacts on public.school_contacts;
create policy admin_all_school_contacts on public.school_contacts
  for all using (public.is_admin()) with check (public.is_admin());

-- (Contatos NÃO ficam públicos — pais não precisam ver os telefones internos)


-- ----------------------------------------------------------------------------
-- 3. MIGRA CONTATOS ANTIGOS de school_agreements pra school_contacts
-- ----------------------------------------------------------------------------

insert into public.school_contacts (school_id, role, name, phone, email, sort_order)
select school_id,
       'Coordenação',
       coalesce(contact_name, 'Contato'),
       contact_phone,
       contact_email,
       0
  from public.school_agreements
 where contact_name is not null
    or contact_phone is not null
    or contact_email is not null;


-- ----------------------------------------------------------------------------
-- 4. REMOVE colunas antigas de contato de school_agreements
-- ----------------------------------------------------------------------------

alter table public.school_agreements drop column if exists contact_name;
alter table public.school_agreements drop column if exists contact_phone;
alter table public.school_agreements drop column if exists contact_email;


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Confira no Table Editor:
--   - school_kits           → coluna `price` (não tem mais price_with_promo e price_without_promo)
--   - school_contacts       → tabela nova (com 1 linha migrada da escola Sena se você cadastrou)
--   - school_agreements     → 3 colunas de contato a menos (contact_name/phone/email)
-- ============================================================================
