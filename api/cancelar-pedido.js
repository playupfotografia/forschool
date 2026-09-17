// ============================================================================
// POST /api/cancelar-pedido
//
// Cancela um pedido a pedido do admin (ex: responsável desistiu, pedido
// duplicado, erro no cadastro). Se o pedido tiver uma cobranca aberta no
// Asaas (PIX ou cartao ainda nao pago), cancela ela TAMBEM antes de marcar o
// pedido como cancelado — senao o responsavel continuaria com um QR/link
// pagavel na tela dele, de um pedido que o admin ja descartou.
//
// So' cancela cobranca que ainda faz sentido cancelar: pedido ja pago nao
// tem cobranca "aberta" pra cancelar no Asaas (a cobranca de la' ja foi
// liquidada) — cancelar aqui so' marca o pedido, sem mexer no Asaas. Se
// precisar de estorno de dinheiro que ja caiu, isso e' feito direto no
// painel do Asaas (fora do escopo desta funcao).
//
// Mesma logica de cancelamento de cobranca ja usada em criar-cobranca.js
// quando o responsavel troca de forma de pagamento — 404 e' esperado
// (cobranca ja apagada ou nunca existiu de verdade).
//
// Body: { order_id }
// So' admin.
// ============================================================================

const { asaas, sb, usuarioDoToken } = require('./_lib.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'Use POST.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const orderId = body.order_id;
    if (!orderId) return res.status(400).json({ erro: 'order_id e obrigatorio.' });

    // ---- So' admin ----------------------------------------------------------
    const uid = await usuarioDoToken(req);
    if (!uid) return res.status(401).json({ erro: 'Sessao expirada. Faca login novamente.' });

    const quem = await sb(`/users?id=eq.${encodeURIComponent(uid)}&select=role`);
    if (quem?.[0]?.role !== 'admin') {
      return res.status(403).json({ erro: 'So o admin pode cancelar pedidos.' });
    }

    // ---- Pedido -------------------------------------------------------------
    const pedidos = await sb(
      `/orders?id=eq.${encodeURIComponent(orderId)}&select=id,order_number,payment_status,gateway,gateway_id`
    );
    const pedido = pedidos?.[0];
    if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado.' });
    if (pedido.payment_status === 'cancelled') {
      return res.status(200).json({ ok: true, ja_estava: true });
    }

    // ---- Cancela a cobranca aberta no Asaas, se houver -----------------------
    // So' faz sentido pra quem ainda nao pagou — pedido ja pago nao tem
    // cobranca "aberta" pra desfazer aqui.
    if (pedido.payment_status !== 'paid' && pedido.gateway === 'asaas' && pedido.gateway_id) {
      try {
        await asaas(`/payments/${pedido.gateway_id}`, { method: 'DELETE' });
      } catch (e) {
        if (e.status !== 404) {
          console.error('cancelar cobranca no Asaas', e.message);
          return res.status(502).json({
            erro: 'Não consegui cancelar a cobrança no Asaas. Tente de novo em instantes.',
          });
        }
      }
    }

    // ---- Marca o pedido como cancelado ---------------------------------------
    await sb(`/orders?id=eq.${encodeURIComponent(orderId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ payment_status: 'cancelled' }),
    });

    return res.status(200).json({ ok: true, pedido: pedido.order_number });
  } catch (err) {
    console.error('cancelar-pedido', err);
    return res.status(err.status && err.status < 500 ? 400 : 500).json({
      erro: err.message || 'Erro ao cancelar pedido.',
    });
  }
};
