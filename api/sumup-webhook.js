// ============================================================================
// POST /api/sumup-webhook
//
// Recebe os eventos da SumUp e confirma o pedido pago no Pix.
//
// Nao precisa cadastrar nada no painel da SumUp: a assinatura e' feita por
// cobranca, no campo `return_url` enviado em criar-cobranca.js.
//
// A SumUp manda so' `{ event_type, id }`, sem status e sem assinatura. Por
// isso este endpoint NUNCA confia no payload: usa o `id` apenas pra
// reconsultar a cobranca na API da SumUp com a nossa chave. Um POST forjado
// nao marca nada como pago — teria que convencer a SumUp de que a cobranca
// foi paga, o que esta fora do alcance de quem descobrisse a URL.
//
// ATENCAO: este aviso nao chegou no primeiro pagamento real (dinheiro entrou,
// webhook nunca veio). Por isso a confirmacao NAO depende dele: o portal
// tambem pergunta ativamente por /api/checar-pagamento. Os dois caminhos
// chamam a mesma funcao, que e' segura de repetir.
// ============================================================================

const { confirmarCheckoutSumup } = require('./_lib.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'Use POST.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const checkoutId = body.id || null;
    if (!checkoutId) {
      return res.status(200).json({ ok: true, ignorado: 'evento sem id de checkout' });
    }

    const r = await confirmarCheckoutSumup(checkoutId);
    if (!r.pedido) {
      // 200 pra SumUp nao reenviar um evento que nao e' nosso
      console.warn('sumup-webhook: pedido nao encontrado', { checkoutId, status: r.status });
      return res.status(200).json({ ok: true, ignorado: 'pedido nao encontrado' });
    }

    return res.status(200).json({ ok: true, status: r.status, pago: r.pago, pedido: r.pedido.id });
  } catch (err) {
    console.error('sumup-webhook', err);
    // 500 faz a SumUp reenviar depois — e' o que queremos numa falha temporaria
    return res.status(500).json({ erro: err.message || 'Erro ao processar webhook.' });
  }
};
