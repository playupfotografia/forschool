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

const { sb, env, avisarVenda, avisarPagamentoDesfeito, resumoFinanceiro } = require('./_lib.js');

// ---------------------------------------------------------------------------
// ⚠️ CONFIRMED e RECEIVED NAO sao a mesma coisa no Asaas:
//   CONFIRMED -> pagamento efetuado, saldo AINDA NAO disponivel na conta
//   RECEIVED  -> o dinheiro caiu
// No PIX os dois acontecem no mesmo instante. No cartao, CONFIRMED vem na
// hora e RECEIVED so' na liquidacao (D+32, ou ~2 dias uteis com antecipacao).
//
// Os dois marcam o pedido como pago — o responsavel pagou, seria errado
// deixar ele vendo "aguardando" por semanas. Quem guarda a diferenca, pra
// conferencia de extrato, e' credited_at (migration_043).
// ---------------------------------------------------------------------------
const PAGOS = new Set([
  'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_APPROVED_BY_RISK_ANALYSIS',
]);

// Eventos que DESFAZEM um pagamento.
// Os dois ultimos sao do cartao e faltavam aqui: o banco do cliente pede a
// autorizacao a ele e ele nao autoriza, ou a analise de risco reprova depois
// de ja' ter confirmado. Sem eles, um pedido que se desfaz ficava "Pago" pra
// sempre e ninguem ficava sabendo.
const DESFEITOS = new Set([
  'PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_DELETED',
  'PAYMENT_REVERSED', 'PAYMENT_CHARGEBACK_DISPUTE',
  'PAYMENT_REPROVED_BY_RISK_ANALYSIS', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
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

    const jaEstavaPago = pedido.payment_status === 'paid';

    if (PAGOS.has(evento)) {
      patch.payment_status = 'paid';
      patch.paid_at = pag.confirmedDate || pag.paymentDate || new Date().toISOString();

      // O Asaas informa o liquido ja' sem a tarifa dele. Guardar isso e' o que
      // permite bater com o extrato e saber o lucro real — e serve de
      // conferencia: se a taxa configurada estiver errada, a diferenca aparece.
      try {
        const fin = await resumoFinanceiro(pag);
        if (fin.liquido > 0) {
          const cobrado = Number(pedido.amount_charged ?? pedido.total_amount) || 0;
          patch.net_amount = fin.liquido;
          if (cobrado > 0) patch.gateway_fee = Math.round((cobrado - fin.liquido) * 100) / 100;
        }
        patch.credit_expected_date = fin.previsto;
        patch.credited_at = fin.caiuEm;
      } catch (e) {
        // Nao gravar e' melhor que gravar metade: numero errado na conferencia
        // e' pior que numero faltando. O pedido e' confirmado do mesmo jeito.
        console.error('resumoFinanceiro:', e.message);
      }
    } else if (DESFEITOS.has(evento)) {
      // Chargeback/estorno volta pra pendente pra o admin olhar, nao apaga nada
      patch.payment_status = evento === 'PAYMENT_REFUNDED' ? 'refunded' : 'pending';
      patch.paid_at = null;
      patch.net_amount = null;
      patch.gateway_fee = null;
      patch.credited_at = null;
      patch.credit_expected_date = null;
    }

    await sb(`/orders?id=eq.${encodeURIComponent(pedido.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });

    // Avisos. Depois de gravar, e sem deixar falha de aviso derrubar nada:
    // se o e-mail ou o Telegram cairem, o pedido ja' esta gravado do mesmo
    // jeito — o aviso e' conveniencia, nao pode mexer no pagamento.
    //
    // "!jaEstavaPago" evita o aviso repetido do parcelado: um pedido em 2x
    // recebe DOIS PAYMENT_CONFIRMED (um por parcela) e mandava dois e-mails
    // de venda pro mesmo pedido.
    if (PAGOS.has(evento) && !jaEstavaPago) {
      try {
        await avisarVenda({ ...pedido, ...patch });
      } catch (e) {
        console.error('avisarVenda', e.message);
      }
    }

    // Pagamento que se desfaz e' mais urgente que venda: e' dinheiro que sumiu
    // depois de o aluno ja' ter sido fotografado. So' avisa se ele realmente
    // estava pago antes — evento de cobranca que nunca foi paga nao e' noticia.
    if (DESFEITOS.has(evento) && jaEstavaPago) {
      try {
        await avisarPagamentoDesfeito({ ...pedido, ...patch }, evento);
      } catch (e) {
        console.error('avisarPagamentoDesfeito', e.message);
      }
    }

    return res.status(200).json({ ok: true, evento, pedido: pedido.id });
  } catch (err) {
    console.error('asaas-webhook', err);
    // 500 faz o Asaas reenviar depois — e' o que queremos numa falha temporaria
    return res.status(500).json({ erro: err.message || 'Erro ao processar webhook.' });
  }
};
