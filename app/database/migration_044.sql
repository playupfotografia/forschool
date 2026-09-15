-- migration_044: conferencia de pagamento ("eu ja' bati este no extrato")
--
-- Contexto:
--   O Daniel confere os pagamentos em tres lugares: o painel do Asaas, o
--   extrato do PIX no banco, e a tela de Pedidos. Ele procura os dois tipos
--   de buraco:
--     - pendente que na verdade PAGOU (PIX manual nao avisa ninguem)
--     - pago que nunca ENTROU (marcado na mao por engano, ou cartao desfeito)
--
--   Faltava onde anotar "este eu ja' olhei". Sem isso, toda conferencia
--   recomeca do zero e a dupla checagem some no meio da lista.
--
-- ⚠️ POR QUE UMA TABELA, E NAO UMA COLUNA EM orders:
--   orders tem uma trigger BEFORE UPDATE que mantem updated_at. Se a marca de
--   conferido fosse uma coluna de orders, gravar a marca bumparia updated_at
--   NO MESMO INSTANTE — e a regra "reconferir se o pedido mudou depois"
--   (checked_at < orders.updated_at) nunca dispararia, porque as duas datas
--   andariam sempre juntas. Em tabela separada, marcar nao toca no pedido, e
--   qualquer alteracao real (pagamento confirmado, valor mudado, status
--   revertido) faz a linha voltar sozinha pra fila de conferencia.
--
--   Isso e' de proposito: pedido conferido como "pendente, realmente nao
--   pagou" que depois for pago PRECISA ser conferido de novo.
--
--   Sem project_id aqui (diferente de student_contacts e ficha_prints):
--   pedido ja' pertence a um projeto so', e conferencia e' sobre dinheiro,
--   nao sobre campanha.
--
-- Rodar no SQL Editor do Supabase.

create table if not exists public.order_checks (
  id         uuid primary key default uuid_generate_v4(),
  order_id   uuid not null unique references public.orders(id) on delete cascade,
  checked_at timestamptz not null default now(),
  notes      text,
  checked_by uuid references auth.users(id)
);

alter table public.order_checks enable row level security;

-- So' o admin. O responsavel nao ve nem altera conferencia de caixa.
drop policy if exists admin_all_order_checks on public.order_checks;
create policy admin_all_order_checks on public.order_checks
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================================
-- FIM. Tabela nova e vazia — nada existente e' alterado.
--
-- Resultado esperado: "Success. No rows returned".
--
-- Efeito no primeiro uso: todo pedido aparece como "a conferir", porque o
-- controle nasce vazio. E' o esperado — a primeira conferencia e' a que poe
-- a casa em ordem; da' pra frente so' aparece o que mudou.
-- ============================================================================
