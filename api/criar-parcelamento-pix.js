// ============================================================================
// POST /api/criar-parcelamento-pix
//
// PIX em Nx — decisao de 22/09/2026: em vez de usar a API de "Assinatura"
// da Woovi (mais nova, mal documentada — ver CLAUDE.md), o proprio sistema
// cria UMA cobranca Woovi POR PARCELA, usando o MESMO endpoint de cobranca
// avulsa ja validado com dinheiro real (api/criar-cobranca.js).
//
// Cada parcela nasce como cobranca tipo OVERDUE (padrao Banco Central):
// fica valida por alguns dias depois do vencimento, com multa/juros somados
// automaticamente pela Woovi se o pai pagar atrasado — sem gerar nada novo
// nesse primeiro atraso. So' quando passa da janela de graca e' que existe
// uma "2a tentativa" (ver gerar-parcela-atrasada.js).
//
// Regra de ouro (igual criar-cobranca.js): o valor NUNCA vem do navegador.
// Body: { order_id }
// ============================================================================

const { woovi, sb, usuarioDoToken, apenasDigitos, telefoneBR } = require('./_lib.js');

// Multa/juros: testado no sandbox em 22/09/2026 — a Woovi ignora
// "type: FIXED" e trata o valor sempre como PERCENTAGE. 200 = 2,00% de
// multa (teto legal pra pessoa fisica), 100 = 1,00% de juros ao mes.
const MULTA_PCT = 200;
const JUROS_PCT = 100;
const DIAS_GRACA = 5; // janela em que a mesma cobranca continua paga com multa/juros embutidos

function emDiasISO(n) {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'Use POST.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const orderId = body.order_id;
    if (!orderId) return res.status(400).json({ erro: 'order_id e obrigatorio.' });

    const uid = await usuarioDoToken(req);
    if (!uid) return res.status(401).json({ erro: 'Sessao expirada. Faca login novamente.' });

    // ---- 1. Pedido + responsavel + aluno -----------------------------------
    const pedidos = await sb(
      `/orders?id=eq.${encodeURIComponent(orderId)}&select=` +
      'id,order_number,total_amount,payment_status,project_id,student_id,user_id,' +
      'users(name,email,cpf,phone),students(name)'
    );
    const pedido = pedidos?.[0];
    if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado.' });
    if (pedido.user_id !== uid) return res.status(403).json({ erro: 'Esse pedido nao e seu.' });
    if (pedido.payment_status === 'paid') {
      return res.status(409).json({ erro: 'Esse pedido ja esta pago.' });
    }

    const valorBase = Number(pedido.total_amount) || 0;
    if (valorBase <= 0) return res.status(400).json({ erro: 'Pedido sem valor.' });

    // ---- 2. O parcelado so' existe se o projeto tiver habilitado -----------
    const cfgs = await sb('/app_settings?id=eq.1&select=pix_gateway,pay_pix_enabled');
    const cfg = cfgs?.[0];
    if (!cfg || cfg.pix_gateway !== 'woovi' || cfg.pay_pix_enabled === false) {
      return res.status(400).json({ erro: 'PIX parcelado exige o motor automatico (Woovi) ligado.' });
    }

    let projCfg = null;
    if (pedido.project_id) {
      const projs = await sb(
        `/projects?id=eq.${encodeURIComponent(pedido.project_id)}&select=pix_parcelas,pix_mode,woovi_conta`
      );
      projCfg = projs?.[0] || null;
    }
    if (projCfg?.pix_mode === 'manual') {
      return res.status(400).json({ erro: 'PIX automatico esta desligado neste projeto.' });
    }
    const n = parseInt(projCfg?.pix_parcelas, 10) || 0;
    if (n < 2) return res.status(400).json({ erro: 'Este projeto nao oferece PIX parcelado.' });
    const wooviConta = projCfg?.woovi_conta || null;

    // ---- 3. Cancela parcelas antigas, se houver (pedido reeditado) ---------
    const antigas = await sb(
      `/pix_installments?order_id=eq.${encodeURIComponent(pedido.id)}&status=in.(scheduled,active)&select=id,gateway_id`
    );
    for (const p of (antigas || [])) {
      if (p.gateway_id) {
        try {
          await woovi(`/api/v1/charge/${encodeURIComponent(p.gateway_id)}`, { method: 'DELETE' }, wooviConta);
        } catch (e) {
          if (e.status !== 404) console.error('cancelar parcela antiga', p.gateway_id, e.message);
        }
      }
    }
    if (antigas?.length) {
      await sb(`/pix_installments?order_id=eq.${encodeURIComponent(pedido.id)}`, {
        method: 'DELETE', headers: { Prefer: 'return=minimal' },
      });
    }

    // ---- 4. Valores de cada parcela (resto fica na ultima) -----------------
    const base = Math.floor((valorBase / n) * 100) / 100;
    const valores = Array.from({ length: n }, (_, i) =>
      i < n - 1 ? base : Math.round((valorBase - base * (n - 1)) * 100) / 100
    );

    // ---- 5. Dados do responsavel --------------------------------------------
    const resp = pedido.users || {};
    const cpf = apenasDigitos(resp.cpf);
    if (!cpf) {
      return res.status(400).json({ erro: 'O responsavel esta sem CPF no cadastro, e a Woovi exige o CPF do pagador.' });
    }
    const aluno = pedido.students?.name || '';

    // ---- 6. Cria as N cobrancas ----------------------------------------------
    const criadas = [];
    for (let k = 1; k <= n; k++) {
      const correlationID = `${pedido.id}-p${k}-${Date.now()}`;
      const dueDate = emDiasISO(30 * (k - 1));
      const cob = await woovi('/api/v1/charge', {
        method: 'POST',
        body: JSON.stringify({
          correlationID,
          value: Math.round(valores[k - 1] * 100),
          type: 'OVERDUE',
          dueDate,
          daysAfterDueDate: DIAS_GRACA,
          fines: { value: MULTA_PCT, type: 'PERCENTAGE' },
          interests: { value: JUROS_PCT, type: 'PERCENTAGE' },
          comment: `Pedido ${pedido.order_number}${aluno ? ' - ' + aluno : ''} - parcela ${k}/${n}`,
          customer: {
            name: resp.name || 'Responsavel',
            taxID: cpf,
            email: resp.email || undefined,
            phone: telefoneBR(resp.phone) ? '+55' + telefoneBR(resp.phone) : undefined,
          },
        }),
      }, wooviConta);

      const linha = {
        order_id: pedido.id,
        installment_number: k,
        total_installments: n,
        value: valores[k - 1],
        due_date: dueDate.slice(0, 10),
        status: 'active',
        attempt: 1,
        gateway: 'woovi',
        gateway_id: correlationID,
        gateway_status: cob.charge?.status || null,
        pix_payload: cob.charge?.brCode || null,
        pix_qr_image: cob.charge?.qrCodeImage || null,
      };
      await sb('/pix_installments', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(linha),
      });
      criadas.push(linha);
    }

    // ---- 7. Grava no pedido — parcela 1 fica visivel nos campos de sempre --
    const primeira = criadas[0];
    await sb(`/orders?id=eq.${encodeURIComponent(pedido.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        payment_method: 'pix_parcelado',
        installments: n,
        amount_charged: valorBase,
        surcharge_amount: 0,
        gateway: 'woovi',
        gateway_id: null,
        pix_payload: primeira.pix_payload,
        pix_qr_image: primeira.pix_qr_image,
        checkout_url: null,
      }),
    });

    return res.status(200).json({
      ok: true,
      parcelas: criadas.map(c => ({
        numero: c.installment_number,
        valor: c.value,
        vencimento: c.due_date,
      })),
      pix_payload: primeira.pix_payload,
      pix_qr_image: primeira.pix_qr_image,
    });
  } catch (err) {
    console.error('criar-parcelamento-pix', err);
    return res.status(err.status && err.status < 500 ? 400 : 500).json({
      erro: err.message || 'Erro ao criar o parcelamento.',
    });
  }
};
