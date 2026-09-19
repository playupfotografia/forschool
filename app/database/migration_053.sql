-- migration_053: "cadastro de conferencia" — aluno de teste que nao conta em nada
--
-- Contexto:
--   Antes de liberar um projeto pras coordenadoras da escola verem, o Daniel
--   quer poder mostrar o catalogo/checkout REAIS daquele projeto (nao o
--   "modo demonstracao" roxo que ja existe, que troca a cor e bloqueia
--   pagamento — as coordenadoras querem ver exatamente o que vai rodar).
--   A ideia e' sempre ter, em todo projeto, um primeiro cadastro "de
--   conferencia": um aluno de verdade, dentro do projeto de verdade, so' que
--   marcado pra nunca contar em nenhum numero — receita, contagem de alunos,
--   relatorio (DRE/Analise de Produtos/Comissoes), fila de "falta
--   fotografar", fichas pra imprimir, painel da TV, nem disparar aviso de
--   venda por e-mail/Telegram.
--
-- O que muda:
--   students.is_test e' marcado no cadastro manual (checkbox "🧪 Cadastro de
--   conferencia" no modal de aluno). orders.is_test e' copiado do aluno na
--   hora de criar o pedido (api/salvar-pedido.js), pra as telas nao
--   precisarem fazer join com students toda vez que somam receita.
--
--   Continua aparecendo normal na lista de Alunos (com badge "🧪 Teste"),
--   pra o Daniel achar e gerenciar — so' fica de fora de agregados/relatorios
--   e da tela por-projeto de Alunos & Pedidos (que e' vista como gestao real
--   do projeto, nao como vitrine de demonstracao).
--
-- Rodar no SQL Editor do Supabase.

alter table public.students
  add column if not exists is_test boolean not null default false;

alter table public.orders
  add column if not exists is_test boolean not null default false;

-- ============================================================================
-- FIM. Nenhum aluno ou pedido existente muda de comportamento — a coluna
-- nasce "false" em todo mundo. So' passa a valer pro aluno que o Daniel
-- marcar manualmente daqui pra frente.
-- ============================================================================
