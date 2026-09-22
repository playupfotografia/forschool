// ============================================================================
// POST /api/woovi-webhook
//
// Recebe os eventos da Woovi e confirma o pedido automaticamente. So' cobre
// PIX (a Woovi nao processa cartao) — cartao continua chegando pelo
// asaas-webhook.js, sem mudar nada la'.
//
// Configurar em: Woovi -> Menu Administrador -> API/Plugins -> Novo Webhook
//   Evento: OPENPIX:CHARGE_COMPLETED
//   URL:    https://forschool.playupfotografia.com.br/api/woovi-webhook
//
// A Woovi nao manda um token fixo (como o Asaas manda) — ela assina cada
// requisicao com a chave PRIVADA dela no header x-webhook-signature. Sem
// validar essa assinatura, qualquer um que descobrisse a URL poderia marcar
// pedidos como pagos. Por isso lemos o corpo CRU (bodyParser desligado
// abaixo) em vez do req.body ja' parseado pela Vercel — reserializar com
// JSON.stringify() pode nao bater byte a byte com o que foi assinado.
// ============================================================================

const { sb, assinaturaWooviValida, avisarVenda } = require('./_lib.js');

module.exports.config = { api: { bodyParser: false } };

async function lerCorpoCru(req) {
  const pedacos = [];
  for await (const pedaco of req) pedacos.push(pedaco);
  return Buffer.concat(pedacos).toString('utf8');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'Use POST.' });
  }

  try {
    const corpoCru = await lerCorpoCru(req);

    // ---- Autenticacao ---------------------------------------------------
    const assinatura = req.headers['x-webhook-signature'];
    const valida = await assinaturaWooviValida(corpoCru, assinatura);
    if (!valida) {
      console.warn('webhook woovi recusado: assinatura invalida');
      return res.status(401).json({ erro: 'Assinatura invalida.' });
    }

    const body = corpoCru ? JSON.parse(corpoCru) : {};
    const evento = body.event;
    const charge = body.charge || {};

    // correlationID guarda "<order_id>-<timestamp>" (setado em criar-cobranca).
    // O id do pedido e' so' a parte antes do ultimo hifen.
    const correlationID = charge.correlationID || null;
    const orderId = correlationID ? correlationID.replace(/-\d+$/, '') : null;

    if (!orderId) {
      return res.status(200).json({ ok: true, ignorado: 'evento sem correlationID' });
    }

    const pedidos = await sb(
      `/orders?id=eq.${encodeURIComponent(orderId)}&select=id,order_number,payment_status,payment_method,is_test,` +
      'total_amount,amount_charged,student:students(name),school:schools(name),user:users(name,phone)'
    );
    const pedido = pedidos?.[0];
    if (!pedido) {
      console.warn('webhook woovi: pedido nao encontrado', { orderId, correlationID, evento });
      return res.status(200).json({ ok: true, ignorado: 'pedido nao encontrado' });
    }

    const patch = {
      gateway_status: charge.status || evento || null,
      gateway_payload: body,
    };

    const jaEstavaPago = pedido.payment_status === 'paid';

    // A Woovi so' manda CHARGE_COMPLETED quando o Pix ja caiu — nao existe a
    // distincao CONFIRMED/RECEIVED que o Asaas tem no cartao (regra 18 do
    // CLAUDE.md). PIX e' na hora: confirmado e recebido sao a mesma coisa.
    if (evento === 'OPENPIX:CHARGE_COMPLETED') {
      patch.payment_status = 'paid';
      patch.paid_at = charge.paidAt || new Date().toISOString();

      // A Woovi devolve a tarifa dela em centavos no campo "fee" do charge.
      const cobrado = Number(pedido.amount_charged ?? pedido.total_amount) || 0;
      const taxaCentavos = Number(charge.fee);
      if (Number.isFinite(taxaCentavos) && taxaCentavos >= 0) {
        const taxa = Math.round(taxaCentavos) / 100;
        patch.gateway_fee = taxa;
        patch.net_amount = Math.round((cobrado - taxa) * 100) / 100;
      }
      // PIX Woovi cai na hora, sem antecipacao — credited_at = o proprio pagamento.
      patch.credited_at = patch.paid_at;
      patch.credit_expected_date = patch.paid_at;
    }

    await sb(`/orders?id=eq.${encodeURIComponent(pedido.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });

    if (evento === 'OPENPIX:CHARGE_COMPLETED' && !jaEstavaPago && !pedido.is_test) {
      try {
        await avisarVenda({ ...pedido, ...patch });
      } catch (e) {
        console.error('avisarVenda (woovi)', e.message);
      }
    }

    return res.status(200).json({ ok: true, evento, pedido: pedido.id });
  } catch (err) {
    console.error('woovi-webhook', err);
    // 500 faz a Woovi reenviar depois — e' o que queremos numa falha temporaria
    return res.status(500).json({ erro: err.message || 'Erro ao processar webhook.' });
  }
};
