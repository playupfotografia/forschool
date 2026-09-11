-- migration_036: tema da foto por produto/variacao (pra ficha da sessao)
--
-- Contexto:
--   O Daniel so' fotografa 2 sessoes temáticas por aluno (ex: "Natal" e
--   "Pequenos Artistas") — o que ele tira de cada aluno depende do que foi
--   comprado (bolinha de Natal → so' precisa da foto de Natal; quebra-
--   cabeça → so' Pequenos Artistas; etc). Hoje isso fica de memoria na
--   hora da sessao. Esta migracao marca cada produto (ou cada variacao,
--   quando o produto tiver — ex: "Caneca" com variacoes "Natal" e
--   "Pequenos Artistas") com o tema que ele exige, pra depois a ficha
--   impressa do aluno avisar sozinha qual(is) foto(s) tirar.
--
--   Texto livre (nao lista fixa) porque os temas mudam por projeto/ano —
--   ano que vem pode ter um tema totalmente diferente, sem precisar de
--   migracao nova. Kit Basico/Intermediario nunca tem tema (fotografados
--   de qualquer forma, uniforme). Kit Promocional nao precisa marcar nada
--   aqui — o admin.html trata "Promocional" como "todos os temas que
--   existirem no momento", automaticamente.
--
-- Rodar no SQL Editor do Supabase.

alter table public.products
  add column if not exists photo_theme text;

alter table public.product_variants
  add column if not exists photo_theme text;

-- ============================================================================
-- FIM. So' colunas novas (nascem vazias) — nenhuma linha existente, pedido
-- ou preco e' alterado.
--
-- Resultado esperado: "Success. No rows returned"
-- Confira no Table Editor: products e product_variants com a coluna
-- photo_theme nova (tudo null). Marque os temas em Admin → Produtos.
-- ============================================================================
