-- migration_063: "copias" so vendem se a familia ja tiver o produto base
--
-- Contexto (27/09/2026, projeto "Recordacao Escola MAIS"): os produtos
-- "1/2/3/4+ COPIAS" sao copias extras de uma pasta que precisa ja existir --
-- nao fazia sentido vender "2 COPIAS" pra quem nunca comprou a Pasta
-- Memorias Escolar (ou a versao IRMAOS). Ate aqui nao havia trava nenhuma:
-- qualquer familia podia fechar um pedido so' de copias, sem nunca ter
-- levado o produto original.
--
-- O que muda (school_prices, igual ao padrao de qty_minima/min_irmaos_projeto
-- da migration_061 -- por escola OU por projeto):
--   is_produto_base      -> marca esse avulso, NESTE projeto, como "produto
--                            base" (ex: a Pasta em si, ou a versao IRMAOS).
--   requer_produto_base  -> marca esse avulso, NESTE projeto, como "so vende
--                            se a familia ja tiver um produto base" -- no
--                            carrinho atual OU ja pago antes por esse aluno.
--
-- Nascem false nos dois -> nada muda pra projeto nenhum ate o admin marcar
-- em Kits & Avulsos -> "Personalizar pra este projeto" -> Pagamento (avancado).
--
-- Rodar no SQL Editor do Supabase.

alter table public.school_prices
  add column if not exists is_produto_base boolean not null default false,
  add column if not exists requer_produto_base boolean not null default false;
