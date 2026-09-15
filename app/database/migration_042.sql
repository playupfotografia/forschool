-- migration_042: conferencia do dia — quem ja' foi fotografado
--
-- Contexto:
--   Depois da sessao o Daniel confere duas coisas, aluno por aluno:
--     1. tirou foto?
--     2. o pagamento entrou?
--
--   A segunda o sistema ja' sabe (orders.payment_status). A PRIMEIRA nao
--   existia em lugar nenhum — ficava na cabeca ou num papel, e aluno
--   esquecido so' aparece quando a escola cobra a foto que nao veio.
--
--   Esta tabela e' so' o "ja' fotografei este aqui": uma linha por aluno por
--   projeto, marcada e desmarcada na mao na tela de Alunos & Pedidos.
--
--   Por projeto de proposito, igual a ficha_prints (migration_041) e
--   student_contacts (migration_032): fotografado em 2026 nao pode aparecer
--   como fotografado no projeto do ano que vem.
--
--   NAO confundir com students.photo_url (foto do carometro) nem com o
--   organizador de fotos: isso aqui e' marcacao de conferencia feita pelo
--   fotografo, nao tem arquivo nenhum por tras.
--
-- Rodar no SQL Editor do Supabase.

create table if not exists public.photo_taken (
  id         uuid primary key default uuid_generate_v4(),
  student_id uuid not null references public.students(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  taken_at   timestamptz not null default now(),
  unique (student_id, project_id)
);

create index if not exists idx_photo_taken_project on public.photo_taken(project_id);

alter table public.photo_taken enable row level security;

-- So' o admin mexe: e' controle de producao. O responsavel nao ve nem altera.
drop policy if exists admin_all_photo_taken on public.photo_taken;
create policy admin_all_photo_taken on public.photo_taken
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================================
-- FIM. Tabela nova e vazia — nada existente e' alterado.
--
-- Resultado esperado: "Success. No rows returned".
--
-- Efeito no primeiro uso: todo mundo aparece com a caixinha 📷 vazia, porque
-- o controle nasce vazio. E' o esperado — marque conferindo as pastas do
-- organizador (ou o cartao) uma vez, e dai' pra frente ele acompanha sozinho.
-- ============================================================================
