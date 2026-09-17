-- migration_047: "precisa refazer a foto" (terceiro estado da caixinha 📷)
--
-- Contexto:
--   Caso real do dia 17/09/2026: um aluno foi fotografado no produto/tema
--   errado. O Daniel anotou isso em "Obs." (students.notes), mas na correria
--   do dia a dia uma nota de texto dentro do cadastro nao aparece pra ninguem
--   sem abrir o aluno — e' facil rolar a lista inteira sem notar que aquele
--   ali precisa ser chamado novamente antes de a sessao acabar.
--
--   A caixinha 📷 (migration_042) ja' resolve dois casos (fotografado /
--   faltou). Este e' um terceiro: FOI fotografado, mas a foto nao serve e
--   precisa ser refeita. E' diferente de "faltou" (nao vale a pena tratar
--   igual a quem nunca apareceu) e diferente de so' deixar como "nao
--   fotografado" (perderia o registro de que ja' foi tentado uma vez).
--
--   Mesma tabela, so' mais um valor no ciclo do clique:
--   vazio -> fotografado -> faltou -> precisa refazer -> vazio.
--
-- Rodar no SQL Editor do Supabase.

alter table public.photo_taken drop constraint if exists photo_taken_status_ck;
alter table public.photo_taken add constraint photo_taken_status_ck
  check (status in ('foto', 'faltou', 'refazer'));

comment on column public.photo_taken.status is
  'foto = fotografado | faltou = nao compareceu na sessao | refazer = fotografado errado, precisa repetir';

-- ============================================================================
-- FIM.
--
-- Resultado esperado: "Success. No rows returned".
--
-- Nao afeta nenhuma marcacao existente — so' passa a aceitar um valor novo.
-- ============================================================================
