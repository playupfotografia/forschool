-- migration_020.sql
-- 1. Logo da escola (logo_url em schools)
-- 2. Tabela de comunicados (announcements) com RLS
-- Executar no SQL Editor do Supabase

-- ============================================================
-- 1. Logo da escola
-- ============================================================
alter table public.schools add column if not exists logo_url text;

-- ============================================================
-- 2. Comunicados / posts do admin para os pais
-- ============================================================
create table if not exists public.announcements (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references public.projects(id) on delete cascade,
  school_id   uuid references public.schools(id) on delete cascade,
  image_url   text,
  caption     text,
  published   boolean default false,
  created_at  timestamptz default now()
);

alter table public.announcements enable row level security;

-- Admin faz tudo
create policy admin_all_announcements on public.announcements
  for all
  using (is_admin())
  with check (is_admin());

-- Pais veem comunicados publicados do projeto do aluno deles
create policy parent_view_announcements on public.announcements
  for select
  using (
    published = true
    and (
      project_id is null
      or exists (
        select 1 from public.students s
        where s.user_id = auth.uid()
          and s.project_id = announcements.project_id
      )
    )
  );

-- ============================================================
-- ATENÇÃO: Criar bucket "media" no Supabase Storage
-- Painel Supabase → Storage → New Bucket
--   Name: media
--   Public bucket: ✅ (sim)
-- ============================================================
