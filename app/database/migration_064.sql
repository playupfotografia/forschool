-- migration_064: produto novo nasce OCULTO ate o admin habilitar por projeto
--
-- Antes: produto sem linha em school_prices era tratado como DISPONIVEL pelo
-- portal (ver regra 11 do CLAUDE.md). Cadastrar um produto fazia ele aparecer
-- na hora em TODO projeto ativo, inclusive projetos com cliente real comprando
-- — o Daniel tinha que entrar projeto por projeto desmarcando o que nao queria.
-- Pedido dele em 30/09/2026: cadastrar tem que ser neutro, ele quem liga onde
-- quer.
--
-- default TRUE aqui e' de proposito: preserva 100% o comportamento de todo
-- produto que ja existe hoje (nenhum catalogo em producao muda com essa
-- migracao). Só produto criado DEPOIS dela pela tela "Novo produto"/"Duplicar
-- produto" do admin nasce com false (a propria tela ja manda esse valor
-- explicito no insert) — esse sim passa a exigir habilitar produto por
-- produto, projeto por projeto, em Kits & Avulsos.
alter table public.products
  add column if not exists default_visible boolean not null default true;
