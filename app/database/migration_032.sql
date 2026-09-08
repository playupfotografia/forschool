-- migration_032: registro de contato com o responsavel (WhatsApp)
--
-- Contexto:
--   Na tela Projetos -> "Alunos/Pedidos" da pra filtrar quem se cadastrou e
--   nao comprou. Faltava poder falar com essas pessoas e, principalmente,
--   lembrar de quem ja foi contatado — senao o mesmo pai recebe a mesma
--   mensagem duas vezes.
--
--   Tabela NOVA de proposito. Guardar isso em students marcaria o aluno pra
--   sempre: o Pedro contatado no projeto de 2026 apareceria como "ja
--   contatado" no projeto de 2027. E guardar em orders nao serve, porque o
--   caso principal ("cadastrou e nao pediu") nao tem pedido nenhum.
--
--   Nao altera nem remove nada existente. Pedidos, valores e status de
--   pagamento ficam intactos.
--
-- Rodar no SQL Editor do Supabase.

-- ----------------------------------------------------------------------------
-- 1. Historico de contatos
-- ----------------------------------------------------------------------------

create table if not exists public.student_contacts (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.students(id) on delete cascade,
  project_id    uuid not null references public.projects(id) on delete cascade,

  -- qual mensagem foi usada: 'sem_pedido' | 'pendente'
  kind          text not null,
  channel       text not null default 'whatsapp',

  contacted_at  timestamptz not null default now(),
  contacted_by  uuid,          -- quem clicou (auth.users.id)
  notes         text
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'student_contacts_kind_check') then
    alter table public.student_contacts
      add constraint student_contacts_kind_check
      check (kind in ('sem_pedido','pendente','outro'));
  end if;
end $$;

-- A tela consulta sempre por projeto; o indice cobre esse caminho.
create index if not exists idx_student_contacts_proj
  on public.student_contacts (project_id, student_id, contacted_at desc);


-- ----------------------------------------------------------------------------
-- 2. RLS — dado administrativo, so' o admin ve
-- ----------------------------------------------------------------------------
-- Pai nenhum deve enxergar o historico de contato das outras familias.
-- is_admin() e' o mesmo padrao ja usado em school_kits e collaborators.

alter table public.student_contacts enable row level security;

drop policy if exists admin_all_student_contacts on public.student_contacts;
create policy admin_all_student_contacts on public.student_contacts
  for all
  using (public.is_admin())
  with check (public.is_admin());


-- ----------------------------------------------------------------------------
-- 3. Modelos de mensagem (editaveis em Admin -> Configuracoes)
-- ----------------------------------------------------------------------------
-- Placeholders trocados na hora do clique:
--   {responsavel} {aluno} {escola} {projeto} {pedido} {valor} {link}

alter table public.app_settings
  add column if not exists contact_msg_sem_pedido text;

alter table public.app_settings
  add column if not exists contact_msg_pendente text;

update public.app_settings
set contact_msg_sem_pedido = coalesce(contact_msg_sem_pedido,
'Oi {responsavel}, tudo bem? Aqui é a Play Up Fotografia 😊

Vi que você já fez o cadastro do(a) {aluno} para as fotos na {escola} — que bom!

Notei que o pedido ainda não foi finalizado. Ficou alguma dúvida sobre os produtos ou sobre o pagamento? Posso te ajudar no que precisar.

Se quiser dar uma olhada no catálogo: {link}'),
    contact_msg_pendente = coalesce(contact_msg_pendente,
'Oi {responsavel}, tudo bem? Aqui é a Play Up Fotografia 😊

O pedido {pedido} do(a) {aluno} está reservadinho aqui, só falta o pagamento pra gente confirmar.

Se precisar do código do PIX de novo, ou tiver qualquer dúvida, é só me chamar que eu resolvo rapidinho.

{link}')
where id = 1;


-- ============================================================================
-- FIM. Resultado esperado: "Success. No rows returned"
--
-- Confira no Table Editor:
--   student_contacts -> tabela nova, vazia
--   app_settings     -> 2 colunas novas, ja preenchidas com as mensagens
--
-- Nada foi alterado em students, orders, order_items ou order_kits.
-- ============================================================================
