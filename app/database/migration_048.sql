-- migration_048: anotar o que falta refazer (photo_taken.note)
--
-- Contexto:
--   O terceiro estado da caixinha 📷 (migration_047, "precisa refazer") dizia
--   SO' que precisa refazer, nao O QUE precisa refazer — o produto certo, o
--   tema, o motivo. Sem isso o fotografo teria que abrir o cadastro do aluno
--   e ler a "Obs." de novo pra lembrar o que estava errado, voltando ao
--   mesmo problema que a caixinha nasceu pra resolver.
--
--   Por projeto, igual ao resto de photo_taken — o que precisava refazer na
--   sessao de 2026 nao faz sentido nenhum aparecer na de 2027.
--
-- Rodar no SQL Editor do Supabase.

alter table public.photo_taken add column if not exists note text;

comment on column public.photo_taken.note is
  'O que precisa refazer (produto/tema/motivo) — so faz sentido quando status = refazer.';

-- ============================================================================
-- FIM.
--
-- Resultado esperado: "Success. No rows returned".
--
-- Coluna nasce vazia pra todo mundo — nao afeta nenhuma marcacao existente.
-- ============================================================================
