// ============================================================================
// POST /api/checar-pagamento
//
// Pergunta pra SumUp se o Pix de um pedido ja foi pago e, se foi, confirma o
// pedido na hora.
//
// Por que existe: no primeiro pagamento real a SumUp nao mandou o webhook —
// o dinheiro entrou e o pedido ficou "aguardando" pra sempre. A documentacao
// deles ja avisa pra sempre reconsultar a API em vez de confiar no aviso.
// Entao a tela de pagamento do portal chama isto de tempos em tempos, e a
// confirmacao passa a nao depender de a SumUp avisar. Se o webhook chegar
// antes, otimo — os dois caminhos usam a mesma funcao, que e' segura de
// repetir.
//
// Body: { order_id }
// Header: Authorization: Bearer <access_token do Supabase>
// ============================================================================

const { sb, usuarioDoToken, confirmarCheckoutSumup } = require('./_lib.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'Use POST.' });
  }

  try {
    // Falamos com o banco por service_role, que ignora RLS — sem esta checagem
    // qualquer um que adivinhasse um id consultaria o pedido alheio.
    const uid = await usuarioDoToken(req);
    if (!uid) return res.status(401).json({ erro: 'Sessao expirada. Faca login novamente.' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const orderId = body.order_id;
    if (!orderId) return res.status(400).json({ erro: 'order_id e obrigatorio.' });

    const pedidos = await sb(
      `/orders?id=eq.${encodeURIComponent(orderId)}&select=id,user_id,gateway,gateway_id,payment_status`
    );
    const pedido = pedidos?.[0];
    if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado.' });
    if (pedido.user_id && pedido.user_id !== uid) {
      return res.status(403).json({ erro: 'Esse pedido nao e seu.' });
    }

    if (pedido.payment_status === 'paid') {
      return res.status(200).json({ ok: true, pago: true });
    }
    // Cartao e' do Asaas, que avisa direito — aqui so' cuidamos do Pix da SumUp
    if (pedido.gateway !== 'sumup' || !pedido.gateway_id) {
      return res.status(200).json({ ok: true, pago: false, motivo: 'sem cobranca sumup' });
    }

    const r = await confirmarCheckoutSumup(pedido.gateway_id);
    return res.status(200).json({ ok: true, pago: r.pago, status: r.status });
  } catch (err) {
    console.error('checar-pagamento', err);
    return res.status(err.status && err.status < 500 ? 400 : 500).json({
      erro: err.message || 'Erro ao consultar o pagamento.',
    });
  }
};
