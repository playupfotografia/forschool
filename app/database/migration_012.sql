-- ============================================================================
-- FOR SCHOOL — Migração 012
-- ============================================================================
-- Introduz Sessões de Foto e Informativo editável por projeto.
--
-- Contexto:
--   Um projeto pode ter várias datas de foto, cada uma com um subconjunto
--   de turmas da escola. Ex: "G1 A e B + 1º Ano Fund I A" fazem foto dia
--   05/07 de manhã; "G4 A e B + 2º Ano Fund I C" fazem foto dia 11/07 à tarde.
--   O prazo do pedido (order_deadline) é único e fica na tabela projects.
--
--   Além disso, o admin pode escolher um modelo de informativo (bilhete_template)
--   e editar uma CÓPIA dentro do projeto. O modelo original não é alterado.
--
-- Mudanças:
--   1. Cria project_sessions (sessões de foto por projeto)
--   2. Cria project_session_classes (turmas de cada sessão)
--   3. Adiciona colunas inf_* em projects (cópia editável do informativo)
--
-- Como executar:
--   SQL Editor do Supabase → New query → Cole todo o arquivo → Run
--   Esperado: "Success. No rows returned"
-- ============================================================================


-- ============================================================================
-- 1. PROJECT_SESSIONS — sessões de ensaio dentro de um projeto
-- ============================================================================

create table if not exists public.project_sessions (
  id          uuid primary key default uuid_generate_v4(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  photo_date  date not null,
  period      text not null default 'manhã'
                check (period in ('manhã','tarde','integral','outro')),
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists idx_project_sessions_project on public.project_sessions(project_id);

alter table public.project_sessions enable row level security;

drop policy if exists admin_all_project_sessions on public.project_sessions;
create policy admin_all_project_sessions on public.project_sessions
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists public_read_project_sessions on public.project_sessions;
create policy public_read_project_sessions on public.project_sessions
  for select using (
    exists (
      select 1 from public.projects p
      where p.id = project_id and p.active = true
    )
  );


-- ============================================================================
-- 2. PROJECT_SESSION_CLASSES — turmas participantes de cada sessão
-- ============================================================================

create table if not exists public.project_session_classes (
  session_id      uuid not null references public.project_sessions(id) on delete cascade,
  school_class_id uuid not null references public.school_classes(id) on delete cascade,
  primary key (session_id, school_class_id)
);

create index if not exists idx_psc_session on public.project_session_classes(session_id);
create index if not exists idx_psc_class   on public.project_session_classes(school_class_id);

alter table public.project_session_classes enable row level security;

drop policy if exists admin_all_psc on public.project_session_classes;
create policy admin_all_psc on public.project_session_classes
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists public_read_psc on public.project_session_classes;
create policy public_read_psc on public.project_session_classes
  for select using (true);


-- ============================================================================
-- 3. COLUNAS inf_* em projects — cópia editável do informativo
-- ============================================================================
-- Quando o admin seleciona um bilhete_template e clica "Copiar modelo",
-- esses campos recebem o conteúdo do template. A partir daí são independentes
-- — editar o modelo original não altera o projeto e vice-versa.
-- inf_edited = true indica que o admin já editou (não sobrescrever automaticamente).

alter table public.projects
  add column if not exists inf_intro_text    text,
  add column if not exists inf_body_html     text,
  add column if not exists inf_delivery_text text,
  add column if not exists inf_uniform_text  text,
  add column if not exists inf_footer_text   text,
  add column if not exists inf_edited        boolean not null default false;


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Conferir no Table Editor:
--   - project_sessions       → tabela nova, vazia
--   - project_session_classes → tabela nova, vazia
--   - projects               → 6 novas colunas (inf_*)
-- ============================================================================
