// ============================================================================
// POST /api/sumup-webhook
//
// Recebe os eventos da SumUp e confirma o pedido pago no Pix automaticamente.
//
// Nao precisa cadastrar nada no painel da SumUp: a assinatura e' feita por
// cobranca, no campo `return_url` enviado em criar-cobranca.js.
//
// A SumUp manda apenas { event_type, id } — sem status e sem assinatura de
// autenticidade. Por isso este endpoint NUNCA confia no que recebe: ele usa
// o `id` so' pra reconsultar o checkout na API da SumUp, com a nossa chave, e
// so' o que a SumUp responder vale. Um POST forjado por alguem que descobrisse
// a URL nao consegue marcar nada como pago — teria que convencer a SumUp de
// que a cobranca foi paga, o que esta fora do alcance dele.
//
// O admin continua podendo marcar como pago na mao; o webhook so' automatiza.
// ============================================================================

const { sb, sumup, avisarVenda } = require('./_lib.js');

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

    // Fonte da verdade: a SumUp. O payload recebido so' serve de indice.
    const checkout = await sumup(`/v0.1/checkouts/${encodeURIComponent(checkoutId)}`);

    // checkout_reference guarda o id do pedido (setado em criar-cobranca). Ele
    // vem antes do gateway_id de proposito: se o responsavel gerou o Pix e
    // depois trocou pro cartao, o pedido aponta pro Asaas, mas o QR da SumUp
    // continua pagavel — e sem esta busca o dinheiro entraria sem confirmar.
    const filtro = checkout.checkout_reference
      ? `id=eq.${encodeURIComponent(checkout.checkout_reference)}`
      : `gateway_id=eq.${encodeURIComponent(checkoutId)}`;

    const pedidos = await sb(
      `/orders?${filtro}&select=` +
      'id,order_number,payment_status,payment_method,installments,' +
      'total_amount,amount_charged,student:students(name),school:schools(name),user:users(name,phone)'
    );
    const pedido = pedidos?.[0];
    if (!pedido) {
      // 200 pra SumUp nao reenviar um evento que nao e' nosso
      console.warn('sumup-webhook: pedido nao encontrado', { checkoutId, status: checkout.status });
      return res.status(200).json({ ok: true, ignorado: 'pedido nao encontrado' });
    }

    // A SumUp reenvia o evento em caso de erro (1min, 5min, 20min, 2h). Sem
    // esta saida, um reenvio depois da confirmacao mandaria o aviso de venda
    // de novo.
    if (pedido.payment_status === 'paid') {
      return res.status(200).json({ ok: true, ignorado: 'ja estava pago' });
    }

    const pago = checkout.status === 'PAID';
    const patch = { gateway_status: checkout.status || null };

    if (pago) {
      patch.payment_status = 'paid';
      patch.paid_at = new Date().toISOString();
      // Quem pagou foi este checkout, entao o pedido tem que refletir isso —
      // vale pro caso do responsavel ter trocado de metodo e pago o Pix velho.
      patch.gateway = 'sumup';
      patch.gateway_id = checkoutId;
      patch.payment_method = 'pix';
      patch.installments = 1;
      patch.amount_charged = Number(checkout.amount) || pedido.amount_charged || pedido.total_amount;
      patch.surcharge_amount = 0;
      // Diferente do Asaas, a SumUp nao informa valor liquido no checkout —
      // net_amount/gateway_fee ficam vazios nos pedidos Pix dela. Nao faz
      // falta: o Pix na conta SumUp Bank nao tem tarifa, entao o liquido e'
      // o proprio valor cobrado.
    }

    await sb(`/orders?id=eq.${encodeURIComponent(pedido.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });

    // Depois de gravar, nunca antes: se o e-mail ou o Telegram cairem, o
    // pedido ja esta confirmado do mesmo jeito.
    if (pago) {
      try {
        await avisarVenda({ ...pedido, ...patch });
      } catch (e) {
        console.error('avisarVenda', e.message);
      }
    }

    return res.status(200).json({ ok: true, status: checkout.status, pedido: pedido.id });
  } catch (err) {
    console.error('sumup-webhook', err);
    // 500 faz a SumUp reenviar depois — e' o que queremos numa falha temporaria
    return res.status(500).json({ erro: err.message || 'Erro ao processar webhook.' });
  }
};
