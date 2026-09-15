-- migration_039: numero da ficha gerado pelo banco (ETAPA 1 de 2)
--
-- Contexto:
--   A politica "admin_all_students" esta como `auth.uid() IS NOT NULL`, o que
--   da' a QUALQUER responsavel logado acesso a todos os alunos de todas as
--   escolas — nome, turma e telefone do responsavel. Precisa virar is_admin().
--
--   So' que o portal depende desse acesso amplo num ponto: ao cadastrar um
--   aluno, ele le o MAIOR photo_seq_number da escola inteira pra calcular o
--   proximo numero de ficha (portal.html, "3. Criar student com numero de
--   ficha auto-gerado"). Apertar a RLS sem resolver isso faria todo aluno novo
--   nascer com ficha #1 — numero repetido na ficha impressa, bagunca no dia da
--   foto. Pior que o problema original, e sem erro na tela.
--
-- O que esta migracao faz:
--   Cria proximo_numero_ficha(), SECURITY DEFINER: roda com privilegio
--   elevado e devolve SO' UM NUMERO. O responsavel recebe "47" e nunca a lista
--   de alunos. Nada de RLS muda aqui.
--
-- ORDEM (importante):
--   1. Rodar ESTA migracao                     <- agora
--   2. Subir o portal que passa a usar a funcao
--   3. Rodar a migration_040, que aperta a RLS
--   Nessa ordem nao existe nenhum momento com o cadastro quebrado.
--
-- Rodar no SQL Editor do Supabase.

create or replace function public.proximo_numero_ficha(p_school_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  proximo integer;
begin
  if p_school_id is null then
    return 1;
  end if;

  select coalesce(max(photo_seq_number), 0) + 1
    into proximo
    from public.students
   where school_id = p_school_id;

  return coalesce(proximo, 1);
end;
$$;

revoke all on function public.proximo_numero_ficha(uuid) from public;
grant execute on function public.proximo_numero_ficha(uuid) to authenticated;

-- ============================================================================
-- FIM. Nada muda de comportamento ainda — so' passa a existir a funcao.
--
-- Resultado esperado: "Success. No rows returned".
-- Confira em Database > Functions: proximo_numero_ficha deve aparecer listada.
--
-- Limitacao conhecida (ja' existia antes): dois responsaveis cadastrando no
-- mesmo segundo podem receber o mesmo numero. E' raro e o admin corrige na
-- mao; resolver de verdade exigiria gerar o numero junto com o insert.
-- ============================================================================
