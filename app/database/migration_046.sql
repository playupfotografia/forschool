-- migration_046: fichas avulsas (QR pre-impresso sem aluno cadastrado ainda)
--
-- Contexto:
--   Caso real: no dia da sessao, duas criancas apareceram sem cadastro
--   nenhum — os pais tinham avisado a escola que elas iriam tirar foto mas
--   esqueceram de fazer o cadastro no portal. A escola ligou pros pais na
--   hora, confirmou que realmente autorizavam, e o admin teve que fazer TUDO
--   manualmente (sem ficha, sem QR, sem cadastro) pra nao perder a foto.
--
--   Esta migracao cria um estoque de "fichas em branco": QR codes com um
--   codigo aleatorio, sem nenhum aluno vinculado, pra imprimir com
--   antecedencia e levar pronto na bolsa de material. Na hora, usa uma ficha
--   avulsa igual a qualquer outra (fotografa o QR antes do aluno). Depois,
--   com calma, o admin "vincula" o codigo a um aluno de verdade (nome, ano,
--   turma) na tela Alunos → 🎫 Fichas avulsas.
--
--   Por escola, nao por projeto: e' material de bolsa, reaproveitavel em
--   qualquer sessao futura daquela escola — nao precisa gerar um lote novo a
--   cada ano.
--
-- Rodar no SQL Editor do Supabase.

create table if not exists public.avulso_tickets (
  id           uuid primary key default uuid_generate_v4(),
  code         text not null unique,
  school_id    uuid not null references public.schools(id) on delete cascade,
  status       text not null default 'livre' check (status in ('livre', 'vinculado')),
  student_id   uuid references public.students(id) on delete set null,
  created_at   timestamptz not null default now(),
  vinculado_at timestamptz
);

create index if not exists idx_avulso_tickets_school_status
  on public.avulso_tickets(school_id, status);

alter table public.avulso_tickets enable row level security;

-- So' o admin mexe nisso — o responsavel nunca ve nem interage com fichas
-- avulsas (elas so' viram um aluno normal depois de vinculadas).
drop policy if exists admin_all_avulso_tickets on public.avulso_tickets;
create policy admin_all_avulso_tickets on public.avulso_tickets
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================================
-- FIM. Tabela nova e vazia — nada existente e' alterado.
--
-- Resultado esperado: "Success. No rows returned".
--
-- Depois de rodar: Admin → Alunos → botao "🎫 Fichas avulsas" → aba
-- "Gerar lote novo" pra imprimir o primeiro lote de uma escola.
-- ============================================================================
