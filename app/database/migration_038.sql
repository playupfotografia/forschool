-- migration_038: mensagem de WhatsApp pra quem ainda nao autorizou a imagem
--
-- Contexto:
--   Vespera do ensaio de 15/09/2026: o Daniel precisou cobrar a autorizacao de
--   quem ainda nao tinha respondido. O botao de WhatsApp em Alunos & Pedidos
--   so' tinha dois modelos — "sem pedido" e "pagamento pendente" — e os dois
--   falam de COMPRAR. Mandar isso pra quem nem autorizou pula uma etapa e
--   reforca justamente o receio que trava essas familias ("vao me cobrar").
--
-- O que muda:
--   1. app_settings.contact_msg_sem_autorizacao — terceiro modelo, usado quando
--      o aluno esta sem autorizacao de imagem (independente de ter pedido).
--   2. Ja' nasce preenchido com um texto pronto, pra funcionar sem depender de
--      alguem escrever antes. E' editavel em Admin > Configuracoes como os
--      outros dois.
--
-- Variaveis disponiveis (as mesmas dos outros modelos):
--   {responsavel} {aluno} {escola} {projeto} {turma} {ano}
--   {data_foto} {periodo} {link}
--
-- Rodar no SQL Editor do Supabase.

alter table public.app_settings
  add column if not exists contact_msg_sem_autorizacao text;

-- Texto padrao. O ponto central e' a frase de que autorizar NAO e' compra —
-- e' o que costuma destravar quem ficou com receio de ser cobrado.
update public.app_settings
set contact_msg_sem_autorizacao =
'Oi {responsavel}, tudo bem? 😊

Aqui é o Daniel, da Play Up Fotografia — somos nós que vamos fazer as fotos na {escola}.

As fotos do(a) {aluno} são {data_foto}, mas a autorização de imagem ainda não foi feita — e sem ela não podemos fotografar.

É rapidinho, menos de 1 minuto:
👉 {link}

⚠️ Importante: autorizar NÃO é compra. Você só permite que a foto seja feita. Depois você vê as fotos e os pacotes com calma e decide se quer comprar ou não, sem compromisso.

Qualquer dúvida é só me chamar por aqui!'
where id = 1
  and (contact_msg_sem_autorizacao is null or contact_msg_sem_autorizacao = '');

-- ============================================================================
-- FIM. Nada existente e' alterado — coluna nova, e o preenchimento so' acontece
-- se ela estiver vazia (rodar de novo nao sobrescreve o que voce editou).
--
-- Resultado esperado: "Success. No rows returned" ou "UPDATE 1".
-- Confira em Admin > Configuracoes > "Mensagens de contato": o terceiro campo
-- deve aparecer preenchido.
-- ============================================================================
