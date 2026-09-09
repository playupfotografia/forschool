-- migration_033: lembrete de retorno de contato (e-mail 5 e 2 dias antes)
--
-- Contexto:
--   Um responsavel contatado (projeto -> Alunos/Pedidos) as vezes responde
--   que so' vai comprar/pagar numa data futura ("so' recebo dia 30"). Hoje
--   isso fica anotado em texto livre (student_contacts.notes), mas nada
--   lembra o admin de voltar a falar com essa familia perto da data.
--
--   Mesmo padrao ja usado pros aniversarios (migration_021): Edge Function
--   'followup-alerts' + pg_cron rodando 1x por dia, mandando e-mail pro
--   mesmo endereco ja configurado (ADMIN_EMAIL / RESEND_API_KEY, os dois ja
--   configurados nos Secrets do projeto desde o birthday-alerts). So' precisa
--   fazer o deploy da funcao nova -- nenhum secret novo.
--
-- Rodar no SQL Editor do Supabase.

-- ----------------------------------------------------------------------------
-- 1. Coluna nova: data pra lembrar (unica, sem virada de ano -- nao e' igual
--    ao aniversario, que se repete todo ano)
-- ----------------------------------------------------------------------------

alter table public.student_contacts
  add column if not exists follow_up_date date;


-- ----------------------------------------------------------------------------
-- 2. Agendamento diario do alerta, as 8h horario de Brasilia (11h UTC) --
--    mesmo horario do birthday-alerts, pra chegar tudo junto de manha.
-- ----------------------------------------------------------------------------
-- Precisa das extensoes pg_cron e pg_net habilitadas (Database -> Extensions)
-- -- se ja rodou a migration_021, elas ja estao ligadas.

select cron.schedule(
  'followup-alerts-daily',
  '0 11 * * *',
  $$
  select net.http_post(
    url     := 'https://drxnaumaxcabjyfubuva.supabase.co/functions/v1/followup-alerts',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRyeG5hdW1heGNhYmp5ZnVidXZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3ODc3OTcsImV4cCI6MjA5NjM2Mzc5N30.CtDJo-60rSrGlknX9DlpvDWuvnL8-yKeT6pYXXz--EM"}'::jsonb,
    body    := '{}'::jsonb
  ) as request_id;
  $$
);

-- ============================================================================
-- FIM. Depois de rodar:
--   1. Fazer o deploy da funcao supabase/functions/followup-alerts (ver
--      instrucoes do Daniel -- painel do Supabase, sem precisar de terminal).
--   2. Conferir: select * from cron.job where jobname = 'followup-alerts-daily';
--   3. Testar chamando a funcao manualmente (Functions -> followup-alerts ->
--      Invoke) depois de anotar uma data de teste em student_contacts.
--
-- Para remover o job (se precisar recriar):
--   select cron.unschedule('followup-alerts-daily');
-- ============================================================================
