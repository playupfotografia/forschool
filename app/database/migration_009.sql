-- ============================================================================
-- FOR SCHOOL — Migração 009
-- ============================================================================
-- REFATORAÇÃO CONCEITUAL: introduz "Projetos" e biblioteca de "Modelos".
--
-- Antes:
--   "Escola" = entidade que tinha TUDO (dados básicos + kits + preços +
--   métodos de pagamento + datas + acordo + alunos + pedidos).
--
-- Depois:
--   "Escola" = só dados básicos (nome, endereço, CNPJ, anos & turmas, contatos)
--   "Projeto" = um evento (Sena Regular 2026, Sena Formatura 2026) que junta:
--       - 1 escola (FK)
--       - 1 informativo (FK pra bilhete_templates)
--       - 1 termo de autorização (FK pra authorization_terms)
--       - kits + preços específicos do projeto
--       - datas, métodos de pagamento, acordo
--       - turmas elegíveis (subset das turmas da escola)
--   Alunos e pedidos pertencem ao PROJETO.
--
-- Esta migração:
--   1. Cria as 3 tabelas novas: bilhete_templates, authorization_terms, projects
--   2. Adiciona project_id nas tabelas existentes (school_kits, school_prices,
--      students, orders)
--   3. Migra dados existentes: cada schools ativa vira 1 projeto.
--
-- A tela atual de "Escolas" continua funcionando, MAS a partir daqui vamos
-- reorganizar a UI pra refletir o novo modelo.
--
-- Como executar:
--   1. SQL Editor → New query
--   2. Cole este arquivo
--   3. Run
--   4. Esperado: "Success. No rows returned"
-- ============================================================================


-- ============================================================================
-- 1. BILHETE_TEMPLATES — biblioteca de informativos
-- ============================================================================

create table if not exists public.bilhete_templates (
  id uuid primary key default uuid_generate_v4(),
  name text not null,                  -- "Informativo Regular 2026"
  type text not null default 'regular' check (type in ('regular','formatura','custom')),

  -- Conteúdo editável do informativo (texto/HTML simples)
  intro_text text,                     -- Saudação inicial
  body_html text,                      -- Corpo principal (descrição do projeto)
  delivery_text text,                  -- "As fotos serão entregues no dia X..."
  uniform_text text,                   -- Lembrete sobre uniforme
  footer_text text,                    -- Observações finais

  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_bilhete_templates_updated on public.bilhete_templates;
create trigger trg_bilhete_templates_updated before update on public.bilhete_templates
  for each row execute function public.set_updated_at();

alter table public.bilhete_templates enable row level security;
drop policy if exists admin_all_bilhete_templates on public.bilhete_templates;
create policy admin_all_bilhete_templates on public.bilhete_templates
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists public_read_bilhete_templates on public.bilhete_templates;
create policy public_read_bilhete_templates on public.bilhete_templates
  for select using (active = true);


-- ============================================================================
-- 2. AUTHORIZATION_TERMS — biblioteca de termos de autorização
-- ============================================================================

create table if not exists public.authorization_terms (
  id uuid primary key default uuid_generate_v4(),
  name text not null,                  -- "Termo Regular 2026"
  type text not null default 'regular' check (type in ('regular','formatura','custom')),

  intro_text text,                     -- "Eu, responsável legal..."
  body_html text,                      -- Termo principal
  purpose_text text,                   -- "Para confecção de fotos para lembranças" ou "PASPATUR DE FORMATURA"

  -- Customização dos 2 checkboxes
  individual_label text default 'Fotos individuais',
  individual_description text default 'Fotos do(a) seu(sua) filho(a) sozinho(a) — pra kits e produtos personalizados.',
  class_label text default 'Fotos de turma',
  class_description text default 'Fotos coletivas da turma com seu(sua) filho(a) presente — pra fotos de grupo e do Paspatur (formaturas).',

  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_authorization_terms_updated on public.authorization_terms;
create trigger trg_authorization_terms_updated before update on public.authorization_terms
  for each row execute function public.set_updated_at();

alter table public.authorization_terms enable row level security;
drop policy if exists admin_all_authorization_terms on public.authorization_terms;
create policy admin_all_authorization_terms on public.authorization_terms
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists public_read_authorization_terms on public.authorization_terms;
create policy public_read_authorization_terms on public.authorization_terms
  for select using (active = true);


-- ============================================================================
-- 3. PROJECTS — o coração do novo modelo
-- ============================================================================

create table if not exists public.projects (
  id uuid primary key default uuid_generate_v4(),
  school_id uuid not null references public.schools(id) on delete restrict,
  bilhete_template_id uuid references public.bilhete_templates(id) on delete set null,
  authorization_term_id uuid references public.authorization_terms(id) on delete set null,

  name text not null,                  -- "Sena Unidade I — Regular 2026"
  slug text unique not null,           -- "sena-u1-regular-2026"
  year int,                            -- 2026
  project_type text not null default 'regular' check (project_type in ('regular','formatura','custom')),

  -- Datas (movidas de schools)
  photo_date date,
  order_deadline date,
  delivery_date date,

  -- Métodos de pagamento (movidos de schools)
  payment_pix_manual boolean not null default true,
  payment_inter boolean not null default false,
  payment_external_link boolean not null default false,

  -- Repasse e custos (movidos de school_agreements)
  repayment_type text default 'nenhum' check (repayment_type in ('nenhum','pct','fixo')),
  repayment_value numeric(10,2) default 0,
  delivery_cost numeric(10,2) default 0,
  material_cost_per_student numeric(10,2) default 0,
  notes text,

  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_projects_school on public.projects(school_id);
create index if not exists idx_projects_slug on public.projects(slug);

drop trigger if exists trg_projects_updated on public.projects;
create trigger trg_projects_updated before update on public.projects
  for each row execute function public.set_updated_at();

alter table public.projects enable row level security;
drop policy if exists admin_all_projects on public.projects;
create policy admin_all_projects on public.projects
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists public_read_projects on public.projects;
create policy public_read_projects on public.projects
  for select using (active = true);


-- ============================================================================
-- 4. Adicionar project_id nas tabelas existentes
-- ============================================================================

alter table public.school_kits
  add column if not exists project_id uuid references public.projects(id) on delete cascade;
create index if not exists idx_school_kits_project on public.school_kits(project_id);

alter table public.school_prices
  add column if not exists project_id uuid references public.projects(id) on delete cascade;
create index if not exists idx_school_prices_project on public.school_prices(project_id);

alter table public.students
  add column if not exists project_id uuid references public.projects(id) on delete set null;
create index if not exists idx_students_project on public.students(project_id);

alter table public.orders
  add column if not exists project_id uuid references public.projects(id) on delete set null;
create index if not exists idx_orders_project on public.orders(project_id);


-- ============================================================================
-- 5. MIGRAÇÃO DE DADOS — cada schools ativa vira 1 projeto "default"
-- ============================================================================

-- Cria 1 projeto pra cada escola existente que ainda não tem projeto associado
insert into public.projects (
  school_id, name, slug, year, project_type,
  photo_date, order_deadline, delivery_date,
  payment_pix_manual, payment_inter, payment_external_link
)
select
  s.id,
  s.name || ' — Projeto inicial',
  s.slug || '-projeto-inicial',
  extract(year from coalesce(s.photo_date, current_date))::int,
  'regular',
  s.photo_date, s.order_deadline, s.delivery_date,
  coalesce(s.payment_pix_manual, true),
  coalesce(s.payment_inter, false),
  coalesce(s.payment_external_link, false)
  from public.schools s
 where s.active = true
   and not exists (select 1 from public.projects p where p.school_id = s.id);

-- Migra acordo de school_agreements pra projects (1 acordo por escola = vai pro 1º projeto)
update public.projects p
   set repayment_type = coalesce(sa.repayment_type, 'nenhum'),
       repayment_value = coalesce(sa.repayment_value, 0),
       delivery_cost = coalesce(sa.delivery_cost, 0),
       material_cost_per_student = coalesce(sa.material_cost_per_student, 0),
       notes = sa.notes
  from public.school_agreements sa
 where sa.school_id = p.school_id;

-- Liga kits e prices existentes ao projeto da escola
update public.school_kits sk
   set project_id = p.id
  from public.projects p
 where p.school_id = sk.school_id
   and sk.project_id is null;

update public.school_prices sp
   set project_id = p.id
  from public.projects p
 where p.school_id = sp.school_id
   and sp.project_id is null;

-- Liga students existentes ao projeto da escola
update public.students s
   set project_id = p.id
  from public.projects p
 where p.school_id = s.school_id
   and s.project_id is null;

-- Liga orders existentes ao projeto da escola
update public.orders o
   set project_id = p.id
  from public.projects p
 where p.school_id = o.school_id
   and o.project_id is null;


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Confira no Table Editor:
--   - bilhete_templates    → tabela nova, vazia
--   - authorization_terms  → tabela nova, vazia
--   - projects             → 1 linha pra cada escola ativa que você tinha
--   - school_kits          → coluna project_id preenchida
--   - school_prices        → coluna project_id preenchida
--   - students             → coluna project_id preenchida
--   - orders               → coluna project_id preenchida
-- ============================================================================
