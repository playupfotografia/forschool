-- migration_054: parcelamento e repasse de taxa POR PROJETO
--
-- Contexto:
--   O projeto da Unidade II foi vendido pras coordenadoras como "3x de
--   R$ 60 sem juros". Hoje as duas configuracoes que mandam nisso
--   (max_installments e surcharge_mode) moram em app_settings, que e' linha
--   unica — mudar pra 3x sem juros mudaria TAMBEM a Unidade I e todo projeto
--   futuro, onde o pai paga o acrescimo do cartao normalmente.
--
-- O que muda:
--   projects ganha max_installments e surcharge_mode, os dois OPCIONAIS.
--   Em branco (null) = "usa o que esta em Configuracoes", que e' como todo
--   projeto existente continua funcionando. Preenchido = vale so' pra aquele
--   projeto. Mesmo padrao do payment_pix_manual, que ja' era por projeto.
--
--   A cadeia de decisao (projeto -> geral) vale nos tres lugares que fazem a
--   conta: o portal (o que o pai ve), api/criar-cobranca.js (o que e'
--   realmente cobrado no Asaas — e' o que vale) e a mensagem de cobranca por
--   WhatsApp do admin.
--
-- Rodar no SQL Editor do Supabase.

alter table public.projects
  add column if not exists max_installments int,
  add column if not exists surcharge_mode text;

-- surcharge_mode so' aceita os mesmos dois valores de app_settings.
-- Em DO block porque constraint nao tem "if not exists" no Postgres.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'projects_surcharge_mode_ck'
  ) then
    alter table public.projects
      add constraint projects_surcharge_mode_ck
      check (surcharge_mode is null or surcharge_mode in ('pass_on', 'absorb'));
  end if;
end $$;

-- ============================================================================
-- FIM. Nenhum projeto muda de comportamento sozinho — as colunas nascem null,
-- o que significa "continua usando Configuracoes". Pra vender 3x sem juros na
-- Unidade II: Admin > Projetos > editar > aba Dados > secao Pagamento >
-- "Maximo de parcelas" = 3 e "Taxa do cartao" = "Absorver (sem juros pro pai)".
-- ============================================================================
