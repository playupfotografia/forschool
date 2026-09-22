-- migration_057: motor do PIX automatico vira configuravel (Asaas ou Woovi),
-- e o modo do PIX passa a valer de verdade POR PROJETO.
--
-- Contexto:
--   O Asaas cobra R$ 1,99 por PIX recebido (R$ 0,99 em promocao ate
--   03/12/2026). A Woovi (ex-OpenPix) foi pesquisada e ficou mais barata
--   (R$ 0,85 fixo) e diversifica: cartao continua no Asaas, PIX passa pra
--   Woovi. So faz PIX, entao o cartao nem entra nessa decisao.
--
--   O plano e trocar o "motor" que ja existe por tras do PIX automatico
--   (app_settings.pay_pix_enabled), sem criar um interruptor novo — so' o
--   provedor muda. E, separado disso, o modo do PIX (automatico ou manual)
--   precisa valer de verdade por projeto: hoje o PIX manual (projects.
--   payment_pix_manual) so' aparece na tela QUANDO o automatico esta
--   desligado no geral — nao da pra ter um projeto automatico e outro manual
--   ao mesmo tempo, que e' exatamente o que se quer (poder desligar so' um
--   projeto se a Woovi tiver problema, tipo o susto do Asaas em 08/09,
--   sem mexer nos outros).
--
-- O que muda:
--   app_settings.pix_gateway  -> 'asaas' | 'woovi'. Default 'asaas': nasce
--     identico ao comportamento de hoje, ninguem muda de motor sozinho.
--   projects.pix_mode  -> 'automatico' | 'manual' | null. Null (o padrao)
--     significa "decide pelo geral", exatamente como funciona hoje. Só
--     quando o Daniel preenche isso num projeto especifico e' que ele passa
--     a mandar mais que o geral naquele projeto.
--
-- Rodar no SQL Editor do Supabase.

alter table public.app_settings
  add column if not exists pix_gateway text not null default 'asaas';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'app_settings_pix_gateway_ck'
  ) then
    alter table public.app_settings
      add constraint app_settings_pix_gateway_ck
      check (pix_gateway in ('asaas', 'woovi'));
  end if;
end $$;

alter table public.projects
  add column if not exists pix_mode text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'projects_pix_mode_ck'
  ) then
    alter table public.projects
      add constraint projects_pix_mode_ck
      check (pix_mode is null or pix_mode in ('automatico', 'manual'));
  end if;
end $$;

-- ============================================================================
-- FIM. Nada muda de comportamento sozinho:
--   - pix_gateway nasce 'asaas' -> PIX automatico continua no Asaas ate' o
--     Daniel trocar em Configuracoes.
--   - pix_mode nasce null em todo projeto -> continua a regra de hoje
--     (automatico manda quando ligado no geral; manual so' aparece quando
--     o geral esta desligado). So' quem tiver pix_mode preenchido passa a
--     decidir sozinho, independente dos outros projetos.
-- ============================================================================
