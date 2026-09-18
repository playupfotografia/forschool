-- migration_049: mensagem de WhatsApp "sessao e' hoje" (lembrete urgente)
--
-- Contexto:
--   O modelo "sem autorizacao" (migration_038) e' generico, pra qualquer dia.
--   Pra sessao que ja' e' hoje o Daniel quis um texto mais urgente ("hoje e'
--   o dia das fotos"), guardado separado do generico — os dois continuam
--   disponiveis, um pra cada situacao.
--
-- O que muda:
--   1. app_settings.contact_msg_sessao_hoje — quarto modelo de mensagem,
--      editavel em Admin > Configuracoes como os outros tres. Mesmas
--      variaveis: {responsavel} {aluno} {escola} {projeto} {turma} {ano}
--      {data_foto} {periodo} {link}.
--   2. Conserta um bug real que ja' existia desde a migration_038: a
--      constraint de student_contacts.kind so' aceitava
--      ('sem_pedido','pendente','outro') — o botao "sem autorizacao" grava
--      kind='sem_autorizacao', que sempre violou essa regra. A mensagem saia
--      no WhatsApp normalmente (o wa.me abre antes de gravar o contato), mas
--      o registro "ja' contatado" nunca era salvo, e um erro silencioso
--      aparecia no console. Corrigido junto porque o kind novo
--      ('sessao_hoje') cairia no mesmo problema.
--
-- Rodar no SQL Editor do Supabase.

alter table public.app_settings
  add column if not exists contact_msg_sessao_hoje text;

update public.app_settings
set contact_msg_sessao_hoje =
'Oi {responsavel}, tudo bem? 😊

Aqui é o Daniel, da Play Up Fotografia! Hoje é o dia das fotos do(a) {aluno} na {escola} 📸, mas a autorização de imagem ainda não foi feita — sem ela infelizmente não podemos fotografar.

É rapidinho, menos de 1 minuto:
👉 {link}

⚠️ Autorizar NÃO é compra — você só libera a foto. Depois você vê as fotos com calma e decide se quer comprar, sem compromisso nenhum.

Consigo contar com você até o fim do dia? Qualquer dúvida me chama por aqui!'
where id = 1
  and (contact_msg_sessao_hoje is null or contact_msg_sessao_hoje = '');

-- Fix da constraint (item 2 acima) — inclui os dois kinds que faltavam.
alter table public.student_contacts drop constraint if exists student_contacts_kind_check;
alter table public.student_contacts
  add constraint student_contacts_kind_check
  check (kind in ('sem_pedido','pendente','outro','sem_autorizacao','sessao_hoje'));

-- ============================================================================
-- FIM. Nada existente e' alterado — coluna nova (so' preenche se estiver
-- vazia, rodar de novo nao sobrescreve edicao) + a constraint so' passa a
-- ACEITAR mais valores, nunca rejeita o que ja' era aceito.
--
-- Resultado esperado: "Success. No rows returned" ou "UPDATE 1".
-- Confira em Admin > Configuracoes > "Mensagens de contato": o quarto campo
-- ("Lembrete: sessao e' hoje") deve aparecer preenchido.
-- ============================================================================
