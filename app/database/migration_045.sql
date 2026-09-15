-- migration_045: aluno que faltou na sessao
--
-- Contexto:
--   A caixinha 📷 (migration_042) so' tinha dois estados: fotografei ou nao
--   fotografei ainda. Mas tem aluno que FALTOU no dia — e esse nao e' um
--   "ainda nao": e' um caso resolvido. Sem essa distincao ele ficava pra
--   sempre na fila de "falta fotografar", e no fim do dia o Daniel nao
--   conseguiria saber se ainda tinha gente pra chamar ou se era so' quem nao
--   veio.
--
--   A tabela deixa de ser "quem foi fotografado" e passa a ser PRESENCA na
--   sessao. O nome photo_taken fica como esta' — renomear tabela em uso
--   quebraria o codigo no ar por nada.
--
--   taken_at continua sendo "quando isto foi marcado": dia da foto, ou dia em
--   que se constatou a falta.
--
-- Rodar no SQL Editor do Supabase.

alter table public.photo_taken
  add column if not exists status text not null default 'foto';

-- Constraint nao aceita "if not exists", entao derruba e recria — assim rodar
-- de novo continua sendo inofensivo.
alter table public.photo_taken drop constraint if exists photo_taken_status_ck;
alter table public.photo_taken add constraint photo_taken_status_ck
  check (status in ('foto', 'faltou'));

comment on column public.photo_taken.status is
  'foto = fotografado | faltou = nao compareceu na sessao';
comment on column public.photo_taken.taken_at is
  'Quando foi marcado: o dia da foto, ou o dia em que se constatou a falta.';

-- ============================================================================
-- FIM.
--
-- Resultado esperado: "Success. No rows returned".
--
-- As marcacoes que ja' existem viram 'foto' pelo default — que e' exatamente
-- o que elas significavam antes desta migracao.
-- ============================================================================
