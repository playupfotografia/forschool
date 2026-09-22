-- migration_058: aviso de "autorizar não é comprar" antes da tela de autorização
--
-- Contexto:
--   Projeto tipo mural/grade (Escola Mais e outros parecidos) precisa fotografar
--   TODA a turma pra montar o quadro coletivo, independente de quem vai comprar
--   produto — quem não autoriza fica com um espaço em branco na montagem
--   (o mesmo problema que o termo "tudo ou nada" da migration_057-equivalente
--   já resolve do lado da autorização parcial). Mas o medo de "autorizar =
--   vou ser cobrado" trava família que nem chegou a pensar em comprar nada —
--   mesmo padrão já visto em contact_msg_sem_autorizacao (seção 8 do CLAUDE.md,
--   14/09/2026): "autorizar NÃO é compra" precisa vir na cara, cedo.
--
-- O que muda:
--   authorization_terms.warning_banner_text — texto opcional que abre sozinho
--   num POPUP por cima de tudo, assim que a tela de autorização carrega,
--   ANTES do responsável ler o termo legal ou ver as caixinhas. Um botão
--   "Entendi, continuar →" fecha o popup e libera a tela normal por trás.
--   Fica em branco = popup nunca aparece, tela continua exatamente como hoje.
--
--   Fica no TERMO, não no projeto: termo já é o objeto reaproveitável entre
--   projetos (é assim que authorization_mode funciona), então escrever o
--   aviso uma vez e atribuir o mesmo termo a quantos projetos precisar
--   (a pedido do Daniel: "pelo menos em dois projetos") é o caminho natural —
--   sem repetir o texto projeto por projeto.
--
-- Rodar no SQL Editor do Supabase.

alter table public.authorization_terms
  add column if not exists warning_banner_text text;

-- ============================================================================
-- FIM. Nenhum termo existente muda de aparência: a coluna nasce vazia em
-- todos, e o portal só abre o popup quando o campo estiver preenchido.
-- ============================================================================
