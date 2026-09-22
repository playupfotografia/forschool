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

const { sb, assinaturaWooviValida, avisarVenda, avisarParcelaPaga } = require('./_lib.js');

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

    const correlationID = charge.correlationID || null;
    if (!correlationID) {
      return res.status(200).json({ ok: true, ignorado: 'evento sem correlationID' });
    }

    // ---- E' o pagamento de uma PARCELA do PIX parcelado (migration_058)? --
    // O correlationID de uma parcela e' "<pedido>-p<numero>-<timestamp>" —
    // procurar direto em pix_installments (id exato) e' mais seguro que
    // tentar recortar o pedido do texto, como o fluxo a vista faz abaixo.
    if (evento === 'OPENPIX:CHARGE_COMPLETED') {
      const parcelas = await sb(
        `/pix_installments?gateway_id=eq.${encodeURIComponent(correlationID)}&select=` +
        'id,order_id,installment_number,total_installments,value,status'
      );
      const parcela = parcelas?.[0];
      if (parcela) {
        if (parcela.status === 'paid') {
          // Reenvio do mesmo evento (a Woovi reenvia se respondermos erro) —
          // ja processado, so' confirma de novo sem duplicar aviso.
          return res.status(200).json({ ok: true, evento, parcela: parcela.id, repetido: true });
        }

        await sb(`/pix_installments?id=eq.${encodeURIComponent(parcela.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'paid',
            paid_at: charge.paidAt || new Date().toISOString(),
            gateway_status: charge.status || evento,
          }),
        });

        const pedidos = await sb(
          `/orders?id=eq.${encodeURIComponent(parcela.order_id)}&select=id,order_number,is_test,` +
          'student:students(name),school:schools(name),user:users(name,phone)'
        );
        const pedido = pedidos?.[0];
        if (!pedido) {
          console.warn('webhook woovi: pedido da parcela nao encontrado', { parcela });
          return res.status(200).json({ ok: true, ignorado: 'pedido da parcela nao encontrado' });
        }

        // Quantas parcelas desse pedido ainda faltam pagar (contando a que
        // acabou de cair, ja marcada 'paid' acima)?
        const restantes = await sb(
          `/pix_installments?order_id=eq.${encodeURIComponent(parcela.order_id)}&status=neq.paid&select=id`
        );
        const todasPagas = !restantes || restantes.length === 0;

        const patchPedido = { has_paid_installment: true };
        if (todasPagas) {
          patchPedido.payment_status = 'paid';
          patchPedido.paid_at = charge.paidAt || new Date().toISOString();
        } else {
          // Ainda falta parcela: a Minha Area (portal.html) le pix_payload/
          // pix_qr_image do PROPRIO pedido pra desenhar o QR de quem esta'
          // pendente (renderPaymentMethods) — sem tocar nessa tela, so'
          // atualizamos esses dois campos pra apontar pra proxima parcela em
          // aberto. Ela ja existe desde a criacao (todas as N cobrancas
          // nascem juntas), so' ainda nao tinha vez de aparecer.
          const proximas = await sb(
            `/pix_installments?order_id=eq.${encodeURIComponent(parcela.order_id)}&status=neq.paid&` +
            'select=pix_payload,pix_qr_image&order=installment_number.asc&limit=1'
          );
          const proxima = proximas?.[0];
          if (proxima) {
            patchPedido.pix_payload = proxima.pix_payload;
            patchPedido.pix_qr_image = proxima.pix_qr_image;
          }
        }
        await sb(`/orders?id=eq.${encodeURIComponent(pedido.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(patchPedido),
        });

        if (!pedido.is_test) {
          try {
            if (todasPagas) {
              // Ultima parcela: e' a venda confirmada de verdade (mesmo
              // aviso "venda confirmada" do pedido a vista/cartao).
              await avisarVenda({ ...pedido, payment_method: 'pix_parcelado', amount_charged: parcela.value });
            } else {
              await avisarParcelaPaga(pedido, parcela);
            }
          } catch (e) {
            console.error('aviso de parcela (woovi)', e.message);
          }
        }

        return res.status(200).json({ ok: true, evento, parcela: parcela.id, pedido: pedido.id, todasPagas });
      }
    }

    // ---- Fluxo a vista (existente) ------------------------------------------
    // correlationID guarda "<order_id>-<timestamp>" (setado em criar-cobranca).
    // O id do pedido e' so' a parte antes do ultimo hifen.
    const orderId = correlationID.replace(/-\d+$/, '');

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
