-- ============================================================================
-- FOR SCHOOL — Migração 008
-- ============================================================================
-- 1. AUTORIZAÇÃO DO RESPONSÁVEL (obrigatória antes do catálogo)
--    Após cadastrar-se no portal, o responsável precisa autorizar o que
--    será fotografado:
--       - Fotos INDIVIDUAIS do(a) aluno(a)
--       - Fotos de TURMA (com o aluno presente)
--    São 2 booleanos independentes — pode autorizar um, outro, os dois, ou
--    nenhum (nesse caso fica registrado e o catálogo é bloqueado).
--
-- 2. TEMPLATE DO BILHETE — cada escola usa "regular" ou "formatura".
--    "Formatura" é o bilhete específico de 9º ano e 3º EM (Paspatur).
--
-- Como executar:
--   1. SQL Editor → New query
--   2. Cole este arquivo
--   3. Run
--   4. Esperado: "Success. No rows returned"
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Autorização do responsável no aluno
-- ----------------------------------------------------------------------------

alter table public.students
  add column if not exists authorize_individual boolean;     -- NULL = pendente

alter table public.students
  add column if not exists authorize_class boolean;          -- NULL = pendente

alter table public.students
  add column if not exists authorization_date timestamptz;

alter table public.students
  add column if not exists authorization_signed_by text;     -- snapshot do nome do responsável que assinou

-- Status derivado (calculado em query, não armazenado):
--   - Ambos NULL                              → "pendente"
--   - Data preenchida + ambos true            → "autorizado_total"
--   - Data preenchida + só individual=true    → "autorizado_individual"
--   - Data preenchida + só class=true         → "autorizado_turma"
--   - Data preenchida + ambos false           → "negado"


-- ----------------------------------------------------------------------------
-- 2. Template do bilhete por escola
-- ----------------------------------------------------------------------------

alter table public.schools
  add column if not exists bilhete_template text not null default 'regular'
    check (bilhete_template in ('regular','formatura'));


-- ----------------------------------------------------------------------------
-- 3. Index pra relatórios mais rápidos
-- ----------------------------------------------------------------------------

create index if not exists idx_students_auth_date on public.students(authorization_date);


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Confira no Table Editor:
--   - students      → 4 colunas novas (authorize_individual, authorize_class,
--                                      authorization_date, authorization_signed_by)
--   - schools       → 1 coluna nova (bilhete_template)
-- ============================================================================
