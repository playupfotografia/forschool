-- migration_052: fotos extras (2/3/4) tambem personalizaveis por projeto
--
-- Contexto:
--   A migration_051 deixou personalizar so' a foto PRINCIPAL do avulso por
--   projeto. O produto global tem ate' 4 fotos (image_url + 3 extras,
--   migration_025) e o pedido do Daniel foi "o mesmo poder do geral" — ou
--   seja, as 3 fotos extras tambem precisam poder ser trocadas so' pra um
--   projeto, sem mexer no produto padrao nem nos outros projetos.
--
-- O que muda:
--   school_prices ganha image_url_2/3/4 — mesma logica da image_url que ja
--   existe: em branco, continua usando a foto extra do produto padrao
--   (products.image_url_2/3/4); preenchido, vale so' pra aquele projeto
--   (ou escola, se for override sem projeto).
--
-- Rodar no SQL Editor do Supabase.

alter table public.school_prices
  add column if not exists image_url_2 text,
  add column if not exists image_url_3 text,
  add column if not exists image_url_4 text;

-- ============================================================================
-- FIM. Nenhum produto ou projeto muda de comportamento sozinho — colunas
-- novas nascem em branco. No modal "Personalizar pra este projeto" (Admin >
-- Projetos > Kits & Avulsos), a foto principal agora vem acompanhada de
-- "Foto extra 1/2/3", do mesmo jeito que a tela de Produtos.
-- ============================================================================
