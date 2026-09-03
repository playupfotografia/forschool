// ============================================================================
// POST /api/asaas-webhook
//
// Recebe os eventos do Asaas e confirma o pedido automaticamente.
// Configurar em: Asaas -> Integracoes -> Webhooks
//   URL:   https://forschool.playupfotografia.com.br/api/asaas-webhook
//   Token: o mesmo valor de ASAAS_WEBHOOK_TOKEN nas env vars da Vercel
//
// O Asaas manda o token no header "asaas-access-token". Sem ele, qualquer um
// que descobrisse a URL poderia marcar pedidos como pagos — por isso a
// checagem abaixo e' obrigatoria, nao opcional.
//
// O admin continua podendo marcar como pago na mao; o webhook so' automatiza.
// ============================================================================

const { sb, env, avisarVenda } = require('./_lib.js');

// Eventos que significam "o dinheiro entrou"
const PAGOS = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']);
// Eventos que desfazem
const DESFEITOS = new Set([
  'PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_DELETED',
  'PAYMENT_REVERSED', 'PAYMENT_CHARGEBACK_DISPUTE',
]);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'Use POST.' });
  }

  try {
    // ---- Autenticacao -------------------------------------------------------
    const esperado = env('ASAAS_WEBHOOK_TOKEN');
    const recebido = req.headers['asaas-access-token'];
    if (!recebido || recebido !== esperado) {
      console.warn('webhook recusado: token invalido');
      return res.status(401).json({ erro: 'Token invalido.' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const evento = body.event;
    const pag = body.payment || {};

    // externalReference guarda o id do pedido (setado em criar-cobranca)
    const orderId = pag.externalReference || null;
    const cobrancaId = pag.id || null;

    if (!orderId && !cobrancaId) {
      return res.status(200).json({ ok: true, ignorado: 'evento sem referencia de pedido' });
    }

    const filtro = orderId
      ? `id=eq.${encodeURIComponent(orderId)}`
      : `gateway_id=eq.${encodeURIComponent(cobrancaId)}`;

    const pedidos = await sb(
      `/orders?${filtro}&select=id,order_number,payment_status,payment_method,installments,` +
      'total_amount,amount_charged,student:students(name),school:schools(name),user:users(name,phone)'
    );
    const pedido = pedidos?.[0];
    if (!pedido) {
      // Responde 200 pra o Asaas nao ficar reenviando um evento que nao e' nosso
      console.warn('webhook: pedido nao encontrado', { orderId, cobrancaId, evento });
      return res.status(200).json({ ok: true, ignorado: 'pedido nao encontrado' });
    }

    const patch = {
      gateway_status: pag.status || evento || null,
      gateway_payload: body,
    };

    if (PAGOS.has(evento)) {
      patch.payment_status = 'paid';
      patch.paid_at = pag.confirmedDate || pag.paymentDate || new Date().toISOString();

      // O Asaas informa o liquido ja' sem a tarifa dele. Guardar isso e' o que
      // permite bater com o extrato e saber o lucro real — e serve de
      // conferencia: se a taxa configurada estiver errada, a diferenca aparece.
      const liquido = Number(pag.netValue);
      if (!Number.isNaN(liquido) && liquido > 0) {
        const cobrado = Number(pedido.amount_charged ?? pedido.total_amount) || 0;
        patch.net_amount = liquido;
        if (cobrado > 0) patch.gateway_fee = Math.round((cobrado - liquido) * 100) / 100;
      }
    } else if (DESFEITOS.has(evento)) {
      // Chargeback/estorno volta pra pendente pra o admin olhar, nao apaga nada
      patch.payment_status = evento === 'PAYMENT_REFUNDED' ? 'refunded' : 'pending';
      patch.paid_at = null;
      patch.net_amount = null;
      patch.gateway_fee = null;
    }

    await sb(`/orders?id=eq.${encodeURIComponent(pedido.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });

    // Aviso de venda. Depois de gravar, e sem await no resultado das falhas:
    // se o e-mail ou o Telegram cairem, o pedido ja esta confirmado do mesmo
    // jeito — o aviso e' conveniencia, nao pode derrubar o pagamento.
    if (PAGOS.has(evento)) {
      try {
        await avisarVenda({ ...pedido, ...patch });
      } catch (e) {
        console.error('avisarVenda', e.message);
      }
    }

    return res.status(200).json({ ok: true, evento, pedido: pedido.id });
  } catch (err) {
    console.error('asaas-webhook', err);
    // 500 faz o Asaas reenviar depois — e' o que queremos numa falha temporaria
    return res.status(500).json({ erro: err.message || 'Erro ao processar webhook.' });
  }
};
