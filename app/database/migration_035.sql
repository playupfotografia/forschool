-- migration_035: duplicidade de cadastro (mesmo aluno, dois responsaveis)
--
-- Contexto:
--   Caso real: mae e pai (ou dois responsaveis diferentes) cadastraram o
--   MESMO filho cada um na sua propria conta, sem usar o campo "2o
--   Responsavel" que existe pra evitar exatamente isso. Resultado: dois
--   registros em `students`, cada um com seu proprio pedido — um pago
--   (pelo pai, ex: P0065), outro pendente (pela mae, ex: P0061). Nada
--   errado nos dados, so' duplicado.
--
--   Em vez de apagar um dos dois (perderia o historico de que isso
--   aconteceu), esta migracao adiciona um jeito de LINKAR os dois
--   registros como "mesma crianca, cadastro diferente" — sem somar nada,
--   so' pra saber que um pedido cobre o outro.
--
-- O que muda:
--   1. Coluna nova em `students`: duplicate_of_student_id (aponta pro
--      OUTRO registro do mesmo aluno). Nasce vazia (null) pra todo mundo
--      que ja existe — nao afeta nenhum aluno/pedido atual.
--   2. Funcao get_pedido_vinculado(): dado um student_id, se ele tiver
--      link (nos dois sentidos — quem linkou OU quem foi linkado), devolve
--      so' numero/status/data do pedido do OUTRO lado. Precisa ser
--      SECURITY DEFINER porque a RLS de `orders` so' deixa cada
--      responsavel ver o proprio pedido (auth.uid() = orders.user_id) — a
--      mae nao pode ler o pedido do pai direto, mas precisa saber que ele
--      esta pago. A funcao devolve so' esses 3 campos, nada de valor,
--      telefone ou qualquer outro dado.
--
-- Rodar no SQL Editor do Supabase.

-- ----------------------------------------------------------------------------
-- 1. Coluna de link — auto-referencia dentro de students
-- ----------------------------------------------------------------------------

alter table public.students
  add column if not exists duplicate_of_student_id uuid references public.students(id) on delete set null;

alter table public.students
  drop constraint if exists students_duplicate_not_self;
alter table public.students
  add constraint students_duplicate_not_self check (duplicate_of_student_id is null or duplicate_of_student_id <> id);

create index if not exists idx_students_duplicate_of on public.students(duplicate_of_student_id);


-- ----------------------------------------------------------------------------
-- 2. Funcao restrita — status do pedido do lado vinculado
-- ----------------------------------------------------------------------------

create or replace function public.get_pedido_vinculado(p_student_id uuid)
returns table(order_number text, payment_status text, paid_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dono uuid;
  v_outro_aluno uuid;
begin
  -- So' responde pra quem e' de fato responsavel por esse aluno (ou admin) —
  -- mesmo com a RLS de students hoje sendo ampla, a funcao confere por
  -- conta propria antes de expor status de pedido de outra pessoa.
  select user_id into v_dono from public.students where id = p_student_id;
  if v_dono is distinct from auth.uid() and not public.is_admin() then
    return;
  end if;

  -- O link pode ter sido feito a partir de qualquer um dos dois lados —
  -- confere os dois sentidos.
  select duplicate_of_student_id into v_outro_aluno from public.students where id = p_student_id;
  if v_outro_aluno is null then
    select id into v_outro_aluno from public.students where duplicate_of_student_id = p_student_id limit 1;
  end if;
  if v_outro_aluno is null then
    return;
  end if;

  return query
    select o.order_number, o.payment_status, o.paid_at
    from public.orders o
    where o.student_id = v_outro_aluno
    order by o.created_at desc
    limit 1;
end;
$$;

revoke all on function public.get_pedido_vinculado(uuid) from public;
grant execute on function public.get_pedido_vinculado(uuid) to authenticated;


-- ============================================================================
-- FIM. Nada em orders, order_items, ou nas linhas ja existentes de students
-- e' alterado — so' coluna nova (vazia) e funcao nova.
--
-- Resultado esperado: "Success. No rows returned"
-- Confira no Table Editor: students com a coluna duplicate_of_student_id
-- nova (tudo null). Em Database > Functions, get_pedido_vinculado deve
-- aparecer listada.
--
-- Pra linkar o caso real (mae/pai): use a tela do admin (Alunos > abrir o
-- aluno da mae > "Vincular duplicata" > escolher o cadastro do pai) —
-- nao precisa rodar SQL manual pra isso, a tela ja atualiza a coluna.
-- ============================================================================
