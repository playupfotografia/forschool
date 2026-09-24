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

const { sb, assinaturaWooviValida, avisarVenda, avisarParcelaPaga, dividirProporcional } = require('./_lib.js');

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
    // correlationID guarda "<referencia>-<timestamp>" (setado em criar-cobranca).
    // referencia e' o id do pedido sozinho, OU "grupo:<id>" quando a cobranca
    // cobre 2 pedidos de irmaos de uma vez (migration_059, pagamento
    // combinado) — nesse caso confirmamos TODOS os pedidos que dividem o
    // mesmo payment_group_id, nao so' um.
    const referencia = correlationID.replace(/-\d+$/, '');
    const refGrupo = referencia.startsWith('grupo:') ? referencia.slice(6) : null;

    const pedidos = await sb(
      (refGrupo
        ? `/orders?payment_group_id=eq.${encodeURIComponent(refGrupo)}`
        : `/orders?id=eq.${encodeURIComponent(referencia)}`) +
      '&select=id,order_number,payment_status,payment_method,is_test,' +
      'total_amount,amount_charged,student:students(name),school:schools(name),user:users(name,phone)'
    );
    if (!pedidos?.length) {
      console.warn('webhook woovi: pedido nao encontrado', { referencia, correlationID, evento });
      return res.status(200).json({ ok: true, ignorado: 'pedido nao encontrado' });
    }

    const patchComum = {
      gateway_status: charge.status || evento || null,
      gateway_payload: body,
    };

    // A Woovi devolve a tarifa dela em centavos no campo "fee" do charge —
    // e' da cobranca INTEIRA, entao rateamos entre os pedidos do grupo pelo
    // que cada um pesa no total cobrado (1 pedido = ele leva tudo).
    let netPorPedido = null, feePorPedido = null;
    if (evento === 'OPENPIX:CHARGE_COMPLETED') {
      patchComum.payment_status = 'paid';
      patchComum.paid_at = charge.paidAt || new Date().toISOString();
      // PIX Woovi cai na hora, sem antecipacao — credited_at = o proprio pagamento.
      patchComum.credited_at = patchComum.paid_at;
      patchComum.credit_expected_date = patchComum.paid_at;

      const taxaCentavos = Number(charge.fee);
      if (Number.isFinite(taxaCentavos) && taxaCentavos >= 0) {
        const taxaTotal = Math.round(taxaCentavos) / 100;
        const pesos = pedidos.map((p) => Number(p.amount_charged ?? p.total_amount) || 0);
        feePorPedido = dividirProporcional(taxaTotal, pesos);
        netPorPedido = pedidos.map((p, i) => {
          const cobrado = Number(p.amount_charged ?? p.total_amount) || 0;
          return Math.round((cobrado - feePorPedido[i]) * 100) / 100;
        });
      }
    }

    for (let i = 0; i < pedidos.length; i++) {
      const pedido = pedidos[i];
      const jaEstavaPago = pedido.payment_status === 'paid';
      const patch = { ...patchComum };
      if (netPorPedido) {
        patch.gateway_fee = feePorPedido[i];
        patch.net_amount = netPorPedido[i];
      }

      await sb(`/orders?id=eq.${encodeURIComponent(pedido.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });

      // Cada pedido do grupo e' de um aluno diferente — os avisos aqui sao
      // vendas DIFERENTES quando combinado, nao duplicadas.
      if (evento === 'OPENPIX:CHARGE_COMPLETED' && !jaEstavaPago && !pedido.is_test) {
        try {
          await avisarVenda({ ...pedido, ...patch });
        } catch (e) {
          console.error('avisarVenda (woovi)', e.message);
        }
      }
    }

    return res.status(200).json({ ok: true, evento, pedidos: pedidos.map((p) => p.id) });
  } catch (err) {
    console.error('woovi-webhook', err);
    // 500 faz a Woovi reenviar depois — e' o que queremos numa falha temporaria
    return res.status(500).json({ erro: err.message || 'Erro ao processar webhook.' });
  }
};
