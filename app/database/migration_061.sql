-- migration_061: acrescimo de parcelamento, quantidade minima e visibilidade
-- por numero de irmaos — tudo POR PRODUTO DENTRO DE UM PROJETO, mais um
-- prazo final pra oferecer parcelamento, POR PROJETO.
--
-- Contexto (26/09/2026, projeto "Recordacao Escola MAIS"):
--   Produto principal: PIX a vista R$170, PIX parcelado 3x = 3x R$60 (R$180
--   no total) — quem parcela paga R$10 a mais, incentivo pra pagar a vista.
--   Produto pra irmaos (a cadastrar depois): so aparece no catalogo pra quem
--   tem 2+ filhos cadastrados NESSA escola/projeto; parcelado tambem tem
--   acrescimo, so que FIXO em R$12 nao importa quantos irmaos (2, 3...) —
--   por isso o acrescimo e' por PRESENCA do produto no pedido/grupo, nunca
--   multiplicado pela quantidade.
--   Produto de copias extras (4 ou mais): preco por unidade normal (nao
--   precisa de coluna nova pra isso — quantidade x preco unitario ja
--   funciona), so precisa de uma quantidade MINIMA (4) pra nao deixar
--   comprar so' 1 unidade no preco pensado pra quem leva 4+. Parcelado
--   SEM acrescimo nesse (fica com a coluna em branco).
--
-- O que muda:
--   1. school_prices ganha 3 colunas, todas opcionais (em branco = sem
--      efeito nenhum, comportamento de hoje mantido em todo produto/projeto
--      que ja existe):
--        pix_parcela_acrescimo — valor fixo (R$) somado ANTES de dividir
--          pelas parcelas, uma unica vez por pedido/grupo (nunca multiplica
--          pela quantidade nem pelo numero de pedidos de irmaos).
--        qty_minima — quantidade minima desse produto no carrinho pra poder
--          finalizar o pedido (ex: 4, pro produto de "4 copias ou mais").
--        min_irmaos_projeto — so aparece no catalogo pra responsavel com
--          esse numero (ou mais) de filhos cadastrados NA MESMA ESCOLA do
--          projeto (ex: 2, pro produto exclusivo de irmaos).
--   2. projects.pix_parcelas_ate — data limite pra oferecer parcelamento
--      nesse projeto. Depois dela, a opcao de parcelar some sozinha (so'
--      fica PIX a vista + cartao) — sem precisar lembrar de desligar na mao.
--      Em branco (o padrao) = sem prazo, comportamento de hoje.
--
-- Rodar no SQL Editor do Supabase.

alter table public.school_prices
  add column if not exists pix_parcela_acrescimo numeric(10,2),
  add column if not exists qty_minima integer,
  add column if not exists min_irmaos_projeto integer;

alter table public.projects
  add column if not exists pix_parcelas_ate date;

-- ============================================================================
-- FIM. Nada muda de comportamento sozinho: as colunas nascem em branco em
-- todo produto/projeto existente. Configure em Admin -> o projeto -> aba
-- Kits & Avulsos -> personalizar o produto (acrescimo/qtd minima/minimo de
-- irmaos) e aba Datas & Pagamento -> "Parcelamento disponivel ate" (a data).
-- ============================================================================
