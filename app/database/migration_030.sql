-- migration_030: modo demonstracao por projeto
--
-- Contexto:
--   As escolas pedem pra ver o portal antes de fechar, e mostram pra
--   coordenacao e direcao. Precisavam de um acesso que percorre tudo —
--   cadastro, autorizacao, catalogo, carrinho, precos — mas trava antes de
--   gerar cobranca.
--
--   Com demo_mode ligado, o portal nao grava pedido nem cria cobranca no
--   Asaas. O responsavel chega ate' a tela de escolha de pagamento, ve os
--   valores reais de PIX e cartao, e ao clicar recebe um aviso de que e'
--   demonstracao. Assim os relatorios nao sujam com venda que nao existiu.
--
-- Rodar no SQL Editor do Supabase.

alter table public.projects
  add column if not exists demo_mode boolean not null default false;


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Confira no Table Editor:
--   projects -> 1 coluna nova (demo_mode)
--
-- Liga/desliga em Admin -> Projetos -> abrir o projeto -> aba Dados.
-- ============================================================================
