// ============================================================================
// POST /api/cancelar-pedido
//
// Cancela um pedido — pedido do ADMIN (responsável desistiu, duplicado, erro
// de cadastro) ou do próprio RESPONSÁVEL pela Minha Área (migration_060).
// O pedido nunca é apagado: vira 'cancelled', com cancelled_at/cancelled_by,
// pra ficar no histórico mesmo que depois ele faça e pague outro.
//
// Antes de marcar como cancelado, derruba a cobrança aberta no gateway (Asaas
// ou Woovi) — senão o responsável continuaria com um QR/link pagável de um
// pedido que não existe mais. 404 é esperado (cobrança já apagada).
//
// Pagamento combinado de irmãos (migration_059): a cobrança cobre os DOIS
// pedidos. Cancelar um derruba a cobrança do grupo, então o irmão também
// perde o QR (volta a mostrar as formas de pagamento normais).
//
// Responsável só cancela o PRÓPRIO pedido, e só se ainda estiver pendente e
// sem parcela paga — pedido com dinheiro dentro é assunto pra Play Up.
// Admin cancela qualquer um; pedido já pago só é marcado aqui (estorno de
// dinheiro que já caiu é feito no painel do gateway, fora desta função).
//
// Body: { order_id }
// ============================================================================

const { asaas, woovi, sb, usuarioDoToken, avisarPedidoCancelado } = require('./_lib.js');

const q = (v) => encodeURIComponent(v);

const LIMPA_COBRANCA = {
  gateway: null, gateway_id: null, gateway_status: null,
  amount_charged: null, surcharge_amount: 0, installments: 1,
  pix_payload: null, pix_qr_image: null, checkout_url: null,
  payment_group_id: null,
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'Use POST.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const orderId = body.order_id;
    if (!orderId) return res.status(400).json({ erro: 'order_id e obrigatorio.' });

    const uid = await usuarioDoToken(req);
    if (!uid) return res.status(401).json({ erro: 'Sessao expirada. Faca login novamente.' });

    const quem = await sb(`/users?id=eq.${q(uid)}&select=role`);
    const ehAdmin = quem?.[0]?.role === 'admin';

    // ---- Pedido -------------------------------------------------------------
    const pedidos = await sb(
      `/orders?id=eq.${q(orderId)}&select=id,order_number,payment_status,payment_method,gateway,gateway_id,` +
      'payment_group_id,has_paid_installment,user_id,is_test,total_amount,project_id,' +
      'student:students(name),school:schools(name),user:users(name,phone),project:projects(woovi_conta)'
    );
    const pedido = pedidos?.[0];
    if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado.' });
    if (pedido.payment_status === 'cancelled') {
      return res.status(200).json({ ok: true, ja_estava: true });
    }

    if (!ehAdmin) {
      if (pedido.user_id !== uid) return res.status(403).json({ erro: 'Esse pedido nao e seu.' });
      if (pedido.payment_status !== 'pending' || pedido.has_paid_installment) {
        return res.status(409).json({
          erro: 'Esse pedido já tem pagamento. Pra cancelar, fale com a Play Up pelo WhatsApp.',
        });
      }
    }

    const wooviConta = pedido.project?.woovi_conta || null;
    const naoPago = pedido.payment_status !== 'paid';

    // ---- Cobrança aberta no gateway ------------------------------------------
    if (naoPago && pedido.gateway_id) {
      try {
        if (pedido.gateway === 'asaas') {
          await asaas(`/payments/${pedido.gateway_id}`, { method: 'DELETE' });
        } else if (pedido.gateway === 'woovi') {
          await woovi(`/api/v1/charge/${q(pedido.gateway_id)}`, { method: 'DELETE' }, wooviConta);
        }
      } catch (e) {
        if (e.status !== 404) {
          console.error('cancelar cobranca', pedido.gateway, e.message);
          return res.status(502).json({
            erro: 'Não consegui cancelar a cobrança. Tente de novo em instantes.',
          });
        }
      }
    }

    // ---- PIX parcelado: cobranças das parcelas em aberto ----------------------
    // Sem isso o robô diário continuaria cobrando um pedido cancelado.
    if (naoPago) {
      const parcelas = await sb(
        `/pix_installments?order_id=eq.${q(orderId)}&status=in.(scheduled,active)&select=id,gateway_id`
      );
      for (const p of parcelas || []) {
        if (p.gateway_id) {
          try {
            await woovi(`/api/v1/charge/${q(p.gateway_id)}`, { method: 'DELETE' }, wooviConta);
          } catch (e) {
            if (e.status !== 404) {
              console.error('cancelar parcela', p.id, e.message);
              return res.status(502).json({
                erro: 'Não consegui cancelar as parcelas do PIX. Tente de novo em instantes.',
              });
            }
          }
        }
        await sb(`/pix_installments?id=eq.${q(p.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'cancelada' }),
        });
      }
    }

    // ---- Irmão que dividia a mesma cobrança ----------------------------------
    if (naoPago && pedido.payment_group_id) {
      await sb(`/orders?payment_group_id=eq.${q(pedido.payment_group_id)}&id=neq.${q(orderId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(LIMPA_COBRANCA),
      });
    }

    // ---- Marca o pedido como cancelado ---------------------------------------
    // Pedido pago mantém os dados da cobrança (histórico do dinheiro que entrou).
    const agora = new Date().toISOString();
    const quemCancelou = ehAdmin ? 'admin' : 'responsavel';
    await sb(`/orders?id=eq.${q(orderId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        ...(naoPago ? LIMPA_COBRANCA : {}),
        payment_status: 'cancelled',
        cancelled_at: agora,
        cancelled_by: quemCancelou,
      }),
    });

    // Aviso só quando foi o responsável — o admin já sabe o que fez.
    if (!ehAdmin && !pedido.is_test) {
      try {
        await avisarPedidoCancelado(pedido);
      } catch (e) {
        console.error('avisarPedidoCancelado', e.message);
      }
    }

    return res.status(200).json({ ok: true, pedido: pedido.order_number, cancelled_by: quemCancelou });
  } catch (err) {
    console.error('cancelar-pedido', err);
    return res.status(err.status && err.status < 500 ? 400 : 500).json({
      erro: err.message || 'Erro ao cancelar pedido.',
    });
  }
};
