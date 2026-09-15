// ============================================================================
// POST /api/resync-pedido
//
// Relê uma cobranca no Asaas e regrava a parte FINANCEIRA do pedido: liquido,
// tarifa, previsao de credito e quando caiu. Serve pra:
//   - consertar pedido que ficou com numero errado (o liquido do parcelado
//     ficou pela metade ate' setembro/2026 — ver migration_043)
//   - recuperar pedido que perdeu um webhook
//   - conferir, na pratica, o que o Asaas responde (devolve diagnostico)
//
// ⚠️ NAO muda payment_status. Se o Asaas discordar do que esta' aqui, a funcao
// RELATA a divergencia e deixa a decisao com o admin. Isso e' de proposito:
// pedido marcado como pago na mao (responsavel que pagou por fora) tem que
// continuar pago, e um resync automatico o derrubaria sem perguntar.
//
// ⚠️ NAO cria nem altera cobranca. So' le' do Asaas e grava aqui.
//
// Body: { order_id }
// So' admin.
// ============================================================================

const { asaas, sb, usuarioDoToken, resumoFinanceiro, liquidoCrivel } = require('./_lib.js');

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
    // Esta funcao fala com o banco por service_role, que ignora RLS. Sem esta
    // checagem, qualquer responsavel logado poderia reescrever o financeiro de
    // qualquer pedido.
    const uid = await usuarioDoToken(req);
    if (!uid) return res.status(401).json({ erro: 'Sessao expirada. Faca login novamente.' });

    const quem = await sb(`/users?id=eq.${encodeURIComponent(uid)}&select=role`);
    if (quem?.[0]?.role !== 'admin') {
      return res.status(403).json({ erro: 'So o admin pode ressincronizar pedidos.' });
    }

    // ---- Pedido -------------------------------------------------------------
    const pedidos = await sb(
      `/orders?id=eq.${encodeURIComponent(orderId)}&select=` +
      'id,order_number,payment_status,gateway,gateway_id,installments,' +
      'total_amount,amount_charged,net_amount,gateway_fee,credit_expected_date,credited_at'
    );
    const pedido = pedidos?.[0];
    if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado.' });
    if (pedido.gateway !== 'asaas' || !pedido.gateway_id) {
      return res.status(400).json({
        erro: 'Este pedido nao tem cobranca no Asaas — nao ha o que ressincronizar.',
      });
    }

    // ---- Le' do Asaas -------------------------------------------------------
    const pag = await asaas(`/payments/${encodeURIComponent(pedido.gateway_id)}`);
    const fin = await resumoFinanceiro(pag);

    const cobrado = Number(pedido.amount_charged ?? pedido.total_amount) || 0;
    const patch = {
      gateway_status: pag.status || null,
      credit_expected_date: fin.previsto,
      credited_at: fin.caiuEm,
    };
    // Liquido so' entra se fizer sentido. Se nao fizer, grava NULL: a tela
    // sabe mostrar "sem dado", e isso e' honesto — ja' "R$ 0,00 de tarifa"
    // seria mentira estampada no caixa (ver liquidoCrivel no _lib).
    const crivel = liquidoCrivel(fin.liquido, cobrado);
    patch.net_amount  = crivel ? fin.liquido : null;
    patch.gateway_fee = crivel ? Math.round((cobrado - fin.liquido) * 100) / 100 : null;

    await sb(`/orders?id=eq.${encodeURIComponent(pedido.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });

    // ---- Divergencia de status: relata, nao conserta ------------------------
    const pagoLa = ['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'].includes(pag.status);
    const pagoAqui = pedido.payment_status === 'paid';
    let divergencia = null;
    if (pagoAqui && !pagoLa) {
      divergencia = `Aqui está PAGO, mas no Asaas a cobrança está ${pag.status}. `
        + 'Se o responsável pagou por fora (PIX manual, dinheiro), está certo assim. '
        + 'Se não, o pagamento pode nunca ter entrado.';
    } else if (!pagoAqui && pagoLa) {
      divergencia = `O Asaas diz ${pag.status}, mas aqui o pedido está como ${pedido.payment_status}. `
        + 'Provavelmente um webhook se perdeu — vale marcar como pago.';
    }

    const mudou = ['net_amount', 'gateway_fee', 'credit_expected_date', 'credited_at']
      .filter(k => String(pedido[k] ?? '') !== String(patch[k] ?? ''));

    return res.status(200).json({
      ok: true,
      pedido: pedido.order_number,
      mudou,
      antes: {
        net_amount: pedido.net_amount,
        gateway_fee: pedido.gateway_fee,
        credit_expected_date: pedido.credit_expected_date,
        credited_at: pedido.credited_at,
      },
      depois: {
        net_amount: patch.net_amount,
        gateway_fee: patch.gateway_fee,
        credit_expected_date: patch.credit_expected_date,
        credited_at: patch.credited_at,
      },
      liquido_confiavel: crivel,
      liquido_bruto_somado: fin.liquido,
      // O acrescimo do cartao existe pra a tarifa sair de dentro do valor
      // cobrado e sobrar o preco de tabela pra Play Up. Entao o liquido certo
      // deste pedido tem que cair perto do total_amount — e' a referencia pra
      // saber se as taxas configuradas estao batendo com as do Asaas.
      esperado_aprox: Number(pedido.total_amount) || 0,
      divergencia,
      // Diagnostico: e' o que permite confirmar se a leitura das antecipacoes
      // esta' certa sem precisar do painel do Asaas aberto do lado. Devolve
      // so' status e datas — nada de dado do pagador.
      diagnostico: {
        status_cobranca: pag.status,
        parcelas: fin.parcelas,
        // Valores crus de cada parcela — e' com isto que se descobre o que
        // netValue significa de verdade nesta altura da cobranca.
        parcelas_brutas: fin.parcelasBrutas,
        // Cada filtro tentado no /anticipations e quantas voltaram. Se todos
        // derem zero, o caminho e' outro (e nao adianta seguir deduzindo).
        tentativas_antecipacao: fin.tentativasAntecipacao,
        antecipacoes: (fin.antecipacoes || []).map(a => ({
          status: a.status,
          ...Object.fromEntries(
            Object.entries(a).filter(([k, v]) => /date|value|fee/i.test(k) && v)
          ),
        })),
        campos_antecipacao: fin.antecipacoes?.[0] ? Object.keys(fin.antecipacoes[0]) : [],
        antecipado_em: fin.antecipadoEm,
      },
    });
  } catch (err) {
    console.error('resync-pedido', err);
    return res.status(err.status && err.status < 500 ? 400 : 500).json({
      erro: err.message || 'Erro ao ressincronizar.',
    });
  }
};
