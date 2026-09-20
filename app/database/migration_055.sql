-- migration_055: comunicado pra uma ESCOLA inteira (conserta furo na RLS)
--
-- Contexto:
--   O comunicado so' podia ser "de um projeto" ou "de todos". Faltava o meio
--   termo mais util no dia a dia: avisar todo mundo de UMA escola de uma vez,
--   sem espalhar pros pais das outras.
--
--   A coluna announcements.school_id JA' EXISTE desde a migration_020 — foi
--   criada junto com a tabela e nunca chegou a ser usada pelo admin nem pelo
--   portal. Esta migracao nao cria coluna nenhuma: ela conserta a POLITICA de
--   leitura, que nao sabia da existencia dela.
--
-- O furo:
--   parent_view_announcements liberava qualquer comunicado com
--   "project_id is null". Um comunicado de escola tem project_id null e
--   school_id preenchido — ou seja, assim que o admin comecasse a usar esse
--   campo, o aviso de UMA escola ficaria legivel pros pais de TODAS. O portal
--   filtrando por fora nao resolveria: RLS e' a unica barreira de verdade
--   (nao existe API propria no meio).
--
-- A regra nova, explicita nos tres casos:
--   project_id preenchido  -> so' quem tem aluno naquele projeto
--   school_id preenchido   -> so' quem tem aluno naquela escola
--   os dois em branco      -> comunicado geral, todo mundo ve
--
-- Rodar no SQL Editor do Supabase.

drop policy if exists parent_view_announcements on public.announcements;

create policy parent_view_announcements on public.announcements
  for select
  using (
    published = true
    and (
      -- Geral: sem projeto E sem escola. O "and school_id is null" e' o
      -- conserto — sem ele, comunicado de escola vazava pra todo mundo.
      (project_id is null and school_id is null)
      or exists (
        select 1 from public.students s
        where s.user_id = auth.uid()
          and s.project_id = announcements.project_id
      )
      or exists (
        select 1 from public.students s
        where s.user_id = auth.uid()
          and s.school_id = announcements.school_id
      )
    )
  );

-- ============================================================================
-- FIM. Nenhum comunicado existente muda de alcance: quem tem project_id
-- continua no projeto, quem tem os dois em branco continua geral (e nenhum
-- tem school_id preenchido hoje, porque o campo nunca foi usado).
-- No admin, a lista de projetos do comunicado agora vem agrupada por escola,
-- com uma opcao "— todos os projetos —" no topo de cada escola.
-- ============================================================================
