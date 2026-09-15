-- migration_040: fecha o acesso amplo de responsavel a alunos (ETAPA 2 de 2)
--
-- ⚠️ SO' RODAR DEPOIS que a migration_039 estiver rodada E o portal novo
--    estiver no ar (o que usa proximo_numero_ficha). Fora dessa ordem, o
--    cadastro de aluno no portal passa a gerar ficha #1 repetida.
--
-- O problema:
--   "admin_all_students" e "admin_all_announcements" estao com
--   `auth.uid() IS NOT NULL` — ou seja, qualquer pessoa logada, inclusive
--   qualquer responsavel cadastrado no portal, passa por elas. Como as
--   politicas do Postgres se somam (basta UMA permitir), na pratica hoje um
--   responsavel consegue ler — e ate' alterar — TODOS os alunos de TODAS as
--   escolas: nome, turma, escola e telefone do responsavel.
--
--   Nao e' invasao: e' a regra do banco permitindo. Mas e' dado de crianca.
--
-- A correcao:
--   Essas duas politicas voltam a exigir is_admin(), como ja' acontece em
--   "admin_all_users" (que e' a prova de que is_admin() funciona nesta base).
--   As politicas de responsavel NAO sao tocadas — ja' estao certas:
--     parent_own_students    SELECT  auth.uid() = user_id
--     parent_insert_students INSERT  auth.uid() = user_id
--     parent_update_students UPDATE  auth.uid() = user_id
--   Entao o pai continua vendo e editando os proprios filhos, e nada mais.
--
-- Rodar no SQL Editor do Supabase.

drop policy if exists admin_all_students on public.students;
create policy admin_all_students on public.students
  for all
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists admin_all_announcements on public.announcements;
create policy admin_all_announcements on public.announcements
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================================
-- FIM.
--
-- Resultado esperado: "Success. No rows returned".
--
-- COMO CONFERIR (vale fazer os dois, nesta ordem):
--   1. No ADMIN: abrir Alunos, abrir Alunos & Pedidos de um projeto, editar um
--      aluno e salvar. Tem que continuar tudo funcionando.
--   2. No PORTAL, logado como um responsavel de teste: cadastrar um filho novo
--      e conferir que o numero da ficha NAO veio 1 (veio o proximo da escola).
--
-- SE ALGO QUEBRAR, desfaz voltando ao estado anterior:
--   drop policy if exists admin_all_students on public.students;
--   create policy admin_all_students on public.students
--     for all using (auth.uid() is not null) with check (auth.uid() is not null);
--   drop policy if exists admin_all_announcements on public.announcements;
--   create policy admin_all_announcements on public.announcements
--     for all using (auth.uid() is not null) with check (auth.uid() is not null);
-- ============================================================================
