-- migration_067: "virada" programada por projeto
--
-- Caso real (13/10/2026, Recordacao Escola MAIS): no dia 26/10 o preco da Pasta
-- passa de R$ 170 para R$ 180, o PIX parcelado acaba e quem pedir depois paga
-- R$ 35 de motoboy. Nao existia nada no sistema que mudasse preco numa data.
--
-- Como funciona: um robo diario (api/cron-virada.js, Vercel Cron) olha estes
-- campos; quando virada_em ja passou e virada_aplicada_em esta vazio, ele
--   1. troca os precos listados em virada_config.precos
--   2. desliga o PIX parcelado do projeto (projects.pix_parcelas = null)
--   3. recalcula os pedidos PENDENTES (novo preco + taxa de motoboy), cancelando
--      a cobranca/QR antigo pra ninguem pagar o valor velho
--   4. (opcional) troca os modelos de WhatsApp (virada_config.whatsapp)
-- e grava virada_aplicada_em. Roda uma vez so' por projeto.
--
-- virada_config (JSON) — tudo opcional:
--   { "precos": [ { "product_id": "<uuid>", "price": 180 } ],
--     "desligar_pix_parcelado": true,
--     "taxa_nos_pendentes": true,
--     "whatsapp": { "sem_pedido": "texto...", "pendente": "texto..." } }
--
-- Fica em projects (e NAO em school_prices) de proposito: o admin regrava
-- school_prices inteiro (delete + insert) a cada "Salvar projeto" e apagaria
-- qualquer coluna nova de la. O update de projects so' mexe nos campos conhecidos.
--
-- Como executar: Supabase -> SQL Editor -> colar tudo e Run. Rodar ANTES de subir
-- o codigo (o robo le estas colunas).

alter table public.projects
  add column if not exists virada_em timestamptz,
  add column if not exists virada_aplicada_em timestamptz,
  add column if not exists virada_config jsonb;
