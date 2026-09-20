-- migration_056: produto em destaque por projeto
--
-- Contexto:
--   O catalogo foi desenhado assumindo que os kits ocupam o topo e puxam o
--   olho. Existe projeto que nao tem kit nenhum — o produto principal e' um
--   avulso — e ai' a tela abre numa grade de cards todos iguais, sem ponto
--   focal, com o produto mais importante perdido no meio dos outros.
--
-- O que muda:
--   school_prices.featured marca UM avulso como o destaque daquele projeto.
--   No portal ele sai num card grande no topo, no espaco que os kits
--   ocupariam, com faixa "Destaque". Os outros seguem na grade normal.
--
--   Fica em school_prices (e nao em products) de proposito: e' a mesma tabela
--   onde preco, nome, descricao, fotos e variacoes ja' sao personalizados por
--   projeto (migrations 051/052). Assim o mesmo produto pode ser o destaque
--   de um projeto e um avulso comum em outro, sem mexer no catalogo global.
--
-- Rodar no SQL Editor do Supabase.

alter table public.school_prices
  add column if not exists featured boolean not null default false;

-- Um destaque por projeto. O admin ja' garante isso ao marcar (marcar um
-- desmarca o anterior), mas o indice impede que uma gravacao torta passe.
-- So' vale pras linhas de PROJETO: no Postgres, NULLs sao sempre distintos
-- entre si, entao a regra nao alcancaria as linhas de escola (project_id
-- null) — e destaque por escola nao e' oferecido na tela.
create unique index if not exists school_prices_um_destaque_por_projeto
  on public.school_prices (project_id)
  where featured = true and project_id is not null;

-- ============================================================================
-- FIM. Nenhum projeto muda de aparencia sozinho — a coluna nasce false em
-- todo mundo. Pra usar: Admin > Projetos > editar > aba Kits & Avulsos >
-- botao da estrela na linha do produto.
-- ============================================================================
