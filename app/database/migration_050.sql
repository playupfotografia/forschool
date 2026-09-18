-- migration_050: encerrar novos cadastros de um projeto, sem travar quem ja'
-- tem conta
--
-- Contexto:
--   Caso real: um projeto ja' teve a sessao de fotos feita e nao ha' mais
--   tempo de atender pedido novo, mas quem ja' esta' cadastrado (a sessao
--   dele ja' aconteceu, so' falta comprar) precisa continuar acessando o
--   portal normalmente pra fechar a compra.
--
-- O que muda:
--   1. projects.registrations_closed — toggle em Admin > Projetos. Quando
--      ligado, o portal deste projeto para de aceitar CADASTRO NOVO
--      (responsavel novo OU filho novo de responsavel ja' cadastrado) e
--      mostra uma tela de agradecimento + "proxima oportunidade" em vez do
--      formulario. Login de quem ja' tem conta continua funcionando igual,
--      inclusive pra comprar mais pros filhos ja' cadastrados.
--   2. projects.closed_message — texto opcional (editavel no mesmo modal)
--      pra customizar a mensagem dessa tela por projeto. Em branco usa o
--      texto padrao do portal.
--
-- Rodar no SQL Editor do Supabase.

alter table public.projects
  add column if not exists registrations_closed boolean not null default false;

alter table public.projects
  add column if not exists closed_message text;

-- ============================================================================
-- FIM. Colunas novas com default false/null — nenhum projeto existente muda
-- de comportamento sozinho. Confira em Admin > Projetos > editar um projeto:
-- deve aparecer a caixinha "🔒 Encerrar novos cadastros" na aba Dados básicos.
-- ============================================================================
