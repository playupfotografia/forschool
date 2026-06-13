-- ============================================================================
-- FOR SCHOOL — Migração 005
-- ============================================================================
-- Tabela de configurações da empresa (Play Up Fotografia).
-- Linha única (id=1) que guarda: chave PIX, WhatsApp, CNPJ, nome do negócio,
-- mensagem padrão pro WhatsApp, e-mail de suporte e endereço.
--
-- Esses valores eram hardcoded no portal.html. Agora ficam no banco e podem
-- ser editados pelo admin a qualquer momento via tela "Configurações".
--
-- Como executar:
--   1. SQL Editor → New query
--   2. Cola este arquivo
--   3. Run (Ctrl+Enter)
--   4. Esperado: "Success. No rows returned"
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Tabela app_settings (linha única, garantida por CHECK id=1)
-- ----------------------------------------------------------------------------

create table if not exists public.app_settings (
  id int primary key default 1,
  business_name text not null default 'Play Up Fotografia',
  cnpj text,
  pix_key text,
  pix_key_type text check (pix_key_type in ('cnpj','cpf','email','phone','random')),
  pix_label text,                          -- ex: "CNPJ Play Up Fotografia"
  whatsapp_number text not null default '5511999363796',  -- formato internacional sem +
  whatsapp_message text default 'Olá! Acabei de fazer um pedido na For School e quero enviar o comprovante.',
  support_email text,
  address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_settings_single_row check (id = 1)
);

-- Insere a linha padrão se ainda não existe
insert into public.app_settings (
  id, business_name, cnpj, pix_key, pix_key_type, pix_label,
  whatsapp_number, whatsapp_message, support_email
)
values (
  1,
  'Play Up Fotografia',
  '22.654.700/0001-32',
  '22.654.700/0001-32',
  'cnpj',
  'CNPJ Play Up Fotografia',
  '5511999363796',
  'Olá! Acabei de fazer um pedido na For School e quero enviar o comprovante.',
  'playupfotografia@gmail.com'
)
on conflict (id) do nothing;


-- ----------------------------------------------------------------------------
-- 2. Trigger updated_at
-- ----------------------------------------------------------------------------

drop trigger if exists trg_app_settings_updated on public.app_settings;
create trigger trg_app_settings_updated before update on public.app_settings
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- 3. RLS — admin gerencia; público pode ler (portal precisa pra exibir PIX)
-- ----------------------------------------------------------------------------

alter table public.app_settings enable row level security;

drop policy if exists admin_all_settings on public.app_settings;
create policy admin_all_settings on public.app_settings
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists public_read_settings on public.app_settings;
create policy public_read_settings on public.app_settings
  for select using (true);


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
-- ============================================================================
