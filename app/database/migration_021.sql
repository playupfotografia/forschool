-- migration_021.sql
-- Agendamento diário do alerta de aniversários via pg_cron + pg_net
-- Executar no SQL Editor do Supabase

-- ============================================================
-- 1. Habilitar extensões (se ainda não estiverem ativas)
-- ============================================================
-- Painel Supabase → Database → Extensions → buscar "pg_cron" e "pg_net" → Enable

-- ============================================================
-- 2. Agendar execução diária às 8h (horário UTC = 5h Brasília)
--    Ajuste o horário se quiser receber em outro momento.
--    Para receber às 8h Brasília (UTC-3), use '0 11 * * *'
-- ============================================================

-- Substitua PROJECT_REF pelo ID do seu projeto Supabase
-- (aparece na URL: https://app.supabase.com/project/PROJECT_REF)
-- Substitua ANON_KEY pela sua anon key (a mesma do supabase.local.env)

select cron.schedule(
  'birthday-alerts-daily',         -- nome do job (único)
  '0 11 * * *',                    -- toda manhã às 8h horário de Brasília
  $$
  select net.http_post(
    url     := 'https://drxnaumaxcabjyfubuva.supabase.co/functions/v1/birthday-alerts',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRyeG5hdW1heGNhYmp5ZnVidXZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3ODc3OTcsImV4cCI6MjA5NjM2Mzc5N30.CtDJo-60rSrGlknX9DlpvDWuvnL8-yKeT6pYXXz--EM"}'::jsonb,
    body    := '{}'::jsonb
  ) as request_id;
  $$
);

-- ============================================================
-- Para verificar se o job foi criado:
--   select * from cron.job;
--
-- Para remover o job (se precisar recriar):
--   select cron.unschedule('birthday-alerts-daily');
-- ============================================================
