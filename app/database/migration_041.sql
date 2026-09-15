-- migration_041: controle de ficha impressa
--
-- Contexto:
--   No dia da sessao chegam pedidos novos enquanto o Daniel fotografa. Ele
--   precisa imprimir as fichas que faltam sem reimprimir a escola inteira —
--   e sem esquecer ninguem.
--
--   So' "ja' imprimi ou nao" nao resolve: aluno que teve ficha impressa como
--   "SO' AUTORIZOU" e faz o pedido durante a sessao fica com a ficha ERRADA na
--   mao (nao mostra o que comprou nem o tema pra fotografar). Essa precisa
--   sair de novo. Por isso o controle guarda QUANDO foi impresso, pra comparar
--   com orders.updated_at (mantido sozinho por trigger desde o schema.sql).
--
--   Regra de "precisa imprimir":
--     nunca impresso  OU  impresso ANTES da ultima alteracao do pedido.
--
--   Por projeto de proposito: ficha impressa no projeto de 2026 nao pode
--   aparecer como "ja' impressa" no projeto do ano que vem. Mesma decisao ja'
--   tomada em student_contacts (migration_032).
--
-- Rodar no SQL Editor do Supabase.

create table if not exists public.ficha_prints (
  id         uuid primary key default uuid_generate_v4(),
  student_id uuid not null references public.students(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  printed_at timestamptz not null default now(),   -- ultima vez que saiu
  unique (student_id, project_id)
);

create index if not exists idx_ficha_prints_project on public.ficha_prints(project_id);

alter table public.ficha_prints enable row level security;

-- So' o admin mexe: e' controle de producao, nao tem nada que o responsavel
-- precise ver ou alterar.
drop policy if exists admin_all_ficha_prints on public.ficha_prints;
create policy admin_all_ficha_prints on public.ficha_prints
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================================
-- FIM. Tabela nova e vazia — nada existente e' alterado.
--
-- Resultado esperado: "Success. No rows returned".
--
-- Efeito no primeiro uso: como a tabela nasce vazia, TODO aluno aparece como
-- "a imprimir" na primeira vez. E' o esperado — o sistema nao tem como saber
-- o que ja' foi impresso antes de existir esse controle.
-- ============================================================================
