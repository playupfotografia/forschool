-- migration_058: PIX parcelado (Nx) via Woovi
--
-- Contexto:
--   Depois de validar o PIX automatico (migration_057) com dinheiro real, o
--   Daniel quis oferecer PIX em 3x pra uma escola especifica. Decisao tomada
--   em conversa: NAO usar a API de "Assinatura/Recorrencia" da Woovi (mais
--   nova, mal documentada) — em vez disso, o proprio sistema cria 1 cobranca
--   Woovi POR PARCELA, usando o MESMO endpoint de cobranca avulsa que ja foi
--   testado com dinheiro de verdade em 22/09/2026.
--
--   Cada cobranca nasce como tipo OVERDUE (cobranca com vencimento, padrao
--   Banco Central): a MESMA cobranca (mesmo QR) fica valida por alguns dias
--   depois do vencimento, com multa/juros somados automaticamente pela Woovi
--   se o pai pagar atrasado — sem o sistema precisar gerar nada novo nesse
--   primeiro atraso. So' se passar da janela de graca e' que o sistema gera
--   uma cobranca nova (2a tentativa, ja com o valor maior). Se essa tambem
--   vencer, a parcela vira "atrasada" e a cobranca passa a ser manual
--   (WhatsApp), igual ja acontece hoje pro PIX manual comum.
--
--   ⚠️ Achado real testando no sandbox: a Woovi ignora "type: FIXED" em
--   fines/interests e sempre trata como PERCENTAGE — por isso o valor de
--   multa/juros e' configurado em porcentagem, nao em reais fixos.
--
-- O que muda:
--   projects.pix_parcelas       -> numero de parcelas (ex: 3), ou vazio =
--                                   parcelado desligado nesse projeto. So'
--                                   faz sentido junto de pix automatico
--                                   (Woovi) ligado — nao existe parcelado
--                                   manual.
--   orders.payment_method       -> aceita o valor novo 'pix_parcelado'.
--   pix_installments (tabela nova) -> uma linha por parcela de um pedido
--                                   parcelado. O pedido inteiro so' vira
--                                   "paid" quando TODAS as parcelas dele
--                                   estiverem pagas (e' isso que o Daniel
--                                   usa pra decidir quando entrega o
--                                   material fisico).
--
-- Rodar no SQL Editor do Supabase.

-- ---------------------------------------------------------------------------
-- 1. Projeto: quantas parcelas oferecer (opcional) + conta Woovi (opcional)
-- ---------------------------------------------------------------------------
alter table public.projects
  add column if not exists pix_parcelas int;

-- Projeto de um socio precisa que o PIX caia numa conta Woovi DIFERENTE da
-- padrao (a do Daniel e' MEI — tem teto de R$81mil/ano, e o dinheiro desse
-- projeto especifico nao pode entrar nela). Guarda so' um ROTULO aqui — a
-- chave de verdade fica na Vercel (WOOVI_APPID_<ROTULO em maiusculo>), nunca
-- no banco. Motivo: projects e' lido pelo portal PUBLICO sem login
-- (select('*') em portal.html) — uma chave de API aqui vazaria pra
-- qualquer visitante do site que abrisse o inspetor do navegador.
-- Vazio = usa a conta padrao (WOOVI_APPID), sempre.
alter table public.projects
  add column if not exists woovi_conta text;

-- ---------------------------------------------------------------------------
-- 2. orders.payment_method ganha o valor novo
-- ---------------------------------------------------------------------------
alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders
  add constraint orders_payment_method_check
  check (payment_method in ('pix','pix_parcelado','dinheiro','cartao_1x','cartao_2x','cartao_debito','outro'));

-- Pedido parcelado fica "pending" ate' a ULTIMA parcela cair — mas o
-- carrinho ("pedido aberto", portal.html) so' pode reabrir/reescrever pedido
-- que ninguem pagou nada ainda. Sem essa flag, pagar a parcela 1 e depois
-- mexer no carrinho reabriria o MESMO pedido pra editar, e salvar-pedido.js
-- nao sabe nada de parcela — reescreveria por cima de um pedido com dinheiro
-- real ja' pago. Marcada pelo webhook quando a 1a parcela confirma.
alter table public.orders
  add column if not exists has_paid_installment boolean not null default false;

-- ---------------------------------------------------------------------------
-- 3. Tabela de parcelas
-- ---------------------------------------------------------------------------
create table if not exists public.pix_installments (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references public.orders(id) on delete cascade,
  installment_number int not null,
  total_installments int not null,
  value              numeric(10,2) not null,
  due_date           date not null,
  -- scheduled: ainda nao criada (nao deveria sobrar nenhuma assim, todas
  --   as parcelas sao criadas juntas no ato da compra) — mantido por
  --   seguranca, caso a criacao de alguma parcela falhe.
  -- active:    cobranca aberta na Woovi, esperando pagamento (dentro do
  --   vencimento ou na janela de graca com multa/juros ja somados).
  -- paid:      confirmada pelo webhook.
  -- atrasada:  passou da 2a tentativa sem pagar — vira cobranca manual.
  status             text not null default 'scheduled'
                      check (status in ('scheduled','active','paid','atrasada')),
  -- 1 = cobranca original; 2 = a "segunda tentativa" gerada apos a janela
  -- de graca da primeira vencer sem pagamento.
  attempt            int not null default 1,
  gateway             text default 'woovi',
  gateway_id          text,   -- correlationID da cobranca ATUAL dessa parcela
  gateway_status      text,
  pix_payload         text,
  pix_qr_image        text,
  paid_at             timestamptz,
  reminder_sent_at    timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (order_id, installment_number)
);

create index idx_pix_installments_order      on public.pix_installments(order_id);
create index idx_pix_installments_gateway_id on public.pix_installments(gateway_id);
create index idx_pix_installments_status_due on public.pix_installments(status, due_date);

create trigger trg_pix_installments_updated_at
  before update on public.pix_installments
  for each row execute function public.set_updated_at();

alter table public.pix_installments enable row level security;

-- Admin ve/mexe em tudo, igual as outras tabelas de pedido.
create policy admin_all_pix_installments on public.pix_installments
  for all using (public.is_admin()) with check (public.is_admin());

-- Pai ve as parcelas dos proprios pedidos (mesmo padrao de parent_own_items
-- em order_items) — precisa pra Minha Area mostrar o QR da parcela ativa.
-- Sem policy de INSERT/UPDATE pro pai: so' as funcoes /api (service_role)
-- criam e atualizam parcela.
create policy parent_own_pix_installments on public.pix_installments
  for select using (
    exists (select 1 from public.orders o where o.id = order_id and o.user_id = auth.uid())
  );

-- ============================================================================
-- FIM. Nada muda de comportamento sozinho: pix_parcelas nasce vazio em todo
-- projeto (parcelado desligado), e a tabela nova comeca vazia. So' passa a
-- valer quando o Daniel preencher "Parcelar PIX em até" num projeto
-- especifico em Admin -> Projetos -> aba Dados -> Pagamento.
-- ============================================================================
