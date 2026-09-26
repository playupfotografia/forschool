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
// uma "2a tentativa" (ver cron-parcelas-atrasadas.js).
//
// Regra de ouro (igual criar-cobranca.js): o valor NUNCA vem do navegador.
// Body: { order_id }  ou  { order_ids: [id1, id2] }
//
// ---- Irmaos pagando junto (migration_059, Etapa 2 — 24/09/2026) ----------
// Com order_ids, os pedidos de irmaos do MESMO projeto viram UM parcelamento:
// cada parcela e' UMA cobranca Woovi com o total do grupo (ja' com o desconto
// de irmaos), e cada pedido ganha a SUA linha em pix_installments por
// parcela, com a fatia rateada do valor e o MESMO gateway_id. Assim tudo que
// ja' le parcela por pedido (admin "X de Y pagas", cancelamento, trava de
// has_paid_installment) continua funcionando sem saber de grupo; quem sabe e'
// o woovi-webhook (confirma todas as linhas daquela cobranca) e o robo diario
// (gera UMA 2a tentativa por cobranca, nao uma por linha).
// ============================================================================

const { woovi, asaas, sb, usuarioDoToken, apenasDigitos, telefoneBR, dividirProporcional, calcularDescontoIrmaos, calcularAcrescimoParcelamento, cancelarParcelasPix } = require('./_lib.js');
const crypto = require('crypto');

// Multa/juros: testado no sandbox em 22/09/2026 — a Woovi ignora
// "type: FIXED" e trata o valor sempre como PERCENTAGE. 200 = 2,00% de
// multa (teto legal pra pessoa fisica), 100 = 1,00% de juros ao mes.
const MULTA_PCT = 200;
const JUROS_PCT = 100;
const DIAS_GRACA = 5; // janela em que a mesma cobranca continua paga com multa/juros embutidos

const q = (v) => encodeURIComponent(v);

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
    const orderIds = Array.isArray(body.order_ids) && body.order_ids.length
      ? [...new Set(body.order_ids.map(String))]
      : (body.order_id ? [String(body.order_id)] : []);
    const combinado = orderIds.length > 1;
    if (!orderIds.length) return res.status(400).json({ erro: 'order_id e obrigatorio.' });

    const uid = await usuarioDoToken(req);
    if (!uid) return res.status(401).json({ erro: 'Sessao expirada. Faca login novamente.' });

    // ---- 1. Pedido(s) + responsavel + aluno --------------------------------
    const idsSql = orderIds.map(q).join(',');
    const brutos = await sb(
      `/orders?id=in.(${idsSql})&select=` +
      'id,order_number,total_amount,payment_status,has_paid_installment,project_id,student_id,user_id,' +
      'gateway,gateway_id,payment_group_id,users(name,email,cpf,phone),students(name)'
    );
    if (!brutos || brutos.length !== orderIds.length) {
      return res.status(404).json({ erro: 'Pedido nao encontrado.' });
    }
    // Ordem que o cliente mandou: o 1o e' o "principal" (dados do responsavel).
    const pedidosGrupo = orderIds.map((id) => brutos.find((p) => p.id === id));
    for (const p of pedidosGrupo) {
      if (p.user_id !== uid) return res.status(403).json({ erro: 'Esse pedido nao e seu.' });
      if (p.payment_status === 'paid') {
        return res.status(409).json({ erro: `O pedido ${p.order_number || ''} ja esta pago.`.trim() });
      }
      if (p.has_paid_installment) {
        return res.status(409).json({
          erro: `O pedido ${p.order_number || ''} ja tem parcela paga. Pra mudar, fale com a Play Up.`,
        });
      }
    }
    if (combinado) {
      const projIds = new Set(pedidosGrupo.map((p) => p.project_id));
      if (projIds.size > 1 || !pedidosGrupo[0].project_id) {
        return res.status(400).json({ erro: 'So da pra pagar junto pedidos do mesmo projeto.' });
      }
    }
    const pedido = pedidosGrupo[0];

    const valorBase0 = pedidosGrupo.reduce((s, p) => s + (Number(p.total_amount) || 0), 0);
    if (valorBase0 <= 0) return res.status(400).json({ erro: 'Pedido sem valor.' });

    // ---- 2. O parcelado so' existe se o projeto tiver habilitado -----------
    const cfgs = await sb('/app_settings?id=eq.1&select=pix_gateway,pay_pix_enabled');
    const cfg = cfgs?.[0];
    if (!cfg || cfg.pix_gateway !== 'woovi' || cfg.pay_pix_enabled === false) {
      return res.status(400).json({ erro: 'PIX parcelado exige o motor automatico (Woovi) ligado.' });
    }

    let projCfg = null;
    if (pedido.project_id) {
      const projs = await sb(
        `/projects?id=eq.${q(pedido.project_id)}&select=pix_parcelas,pix_parcelas_ate,pix_mode,woovi_conta,sibling_discount_mode,sibling_discount_value`
      );
      projCfg = projs?.[0] || null;
    }
    if (projCfg?.pix_mode === 'manual') {
      return res.status(400).json({ erro: 'PIX automatico esta desligado neste projeto.' });
    }
    const n = parseInt(projCfg?.pix_parcelas, 10) || 0;
    if (n < 2) return res.status(400).json({ erro: 'Este projeto nao oferece PIX parcelado.' });
    // Prazo final (migration_061) — depois dessa data o parcelamento nao e'
    // mais oferecido nesse projeto, mesmo com pix_parcelas configurado.
    if (projCfg?.pix_parcelas_ate && new Date().toISOString().slice(0, 10) > projCfg.pix_parcelas_ate) {
      return res.status(400).json({ erro: 'O prazo para parcelar o PIX neste projeto ja passou. So a vista.' });
    }
    const wooviConta = projCfg?.woovi_conta || null;

    // Desconto de irmaos: mesma conta do criar-cobranca.js (no servidor).
    const descontoIrmaos = combinado ? calcularDescontoIrmaos(valorBase0, projCfg) : 0;
    // Acrescimo de parcelamento (migration_061) — por produto, uma vez so'
    // por pedido/grupo, nunca multiplicado por quantidade ou por irmao.
    const acrescimoParcelamento = pedido.project_id
      ? await calcularAcrescimoParcelamento(orderIds, pedido.project_id)
      : 0;
    const valorBase = Math.round((valorBase0 - descontoIrmaos + acrescimoParcelamento) * 100) / 100;

    const resp = pedido.users || {};
    const cpf = apenasDigitos(resp.cpf);
    if (!cpf) {
      return res.status(400).json({ erro: 'O responsavel esta sem CPF no cadastro, e a Woovi exige o CPF do pagador.' });
    }

    // ---- 3. Cobrancas antigas: a vista e parcelas ---------------------------
    // Antes so' as parcelas antigas eram canceladas — quem vinha do PIX a
    // vista (ou do cartao) pro parcelado ficava com o QR antigo ainda
    // pagavel. Agora as duas coisas caem antes de criar as novas.
    {
      const vistos = new Set();
      for (const p of pedidosGrupo) {
        const chave = p.gateway + ':' + p.gateway_id;
        if (!p.gateway || !p.gateway_id || vistos.has(chave)) continue;
        vistos.add(chave);
        try {
          if (p.gateway === 'woovi') {
            await woovi(`/api/v1/charge/${q(p.gateway_id)}`, { method: 'DELETE' }, wooviConta);
          } else if (p.gateway === 'asaas') {
            await asaas(`/payments/${p.gateway_id}`, { method: 'DELETE' });
          }
        } catch (e) {
          if (e.status !== 404) {
            console.error('cancelar cobranca anterior', p.gateway, e.message);
            return res.status(502).json({ erro: 'Nao consegui cancelar a cobranca anterior. Tente de novo em instantes.' });
          }
        }
      }
    }
    try {
      await cancelarParcelasPix(orderIds, wooviConta);
    } catch (e) {
      console.error('cancelar parcelas antigas', e.causa || e.message);
      return res.status(502).json({ erro: e.message });
    }
    // A tabela tem unique(order_id, installment_number): as linhas canceladas
    // de um parcelamento anterior DESTE pedido (que continua pendente e sem
    // parcela paga — checado la' em cima, entao nunca teve dinheiro dentro)
    // saem pra dar lugar as novas. Era o que o codigo antigo ja' fazia.
    await sb(`/pix_installments?order_id=in.(${idsSql})&status=eq.cancelada`, {
      method: 'DELETE', headers: { Prefer: 'return=minimal' },
    });

    // ---- 4. Valores de cada parcela (resto fica na ultima) -----------------
    const base = Math.floor((valorBase / n) * 100) / 100;
    const valores = Array.from({ length: n }, (_, i) =>
      i < n - 1 ? base : Math.round((valorBase - base * (n - 1)) * 100) / 100
    );
    // Fatia de cada pedido em cada parcela, pelo peso de cada um no total.
    const pesos = pedidosGrupo.map((p) => Number(p.total_amount) || 0);

    const groupId = combinado ? crypto.randomUUID() : null;
    const referencia = combinado ? `grupo:${groupId}` : pedido.id;
    const numeros = pedidosGrupo.map((p) => p.order_number).filter(Boolean).join('+');
    const alunos = pedidosGrupo.map((p) => p.students?.name).filter(Boolean).join(' + ');

    // ---- 5. Cria as N cobrancas ----------------------------------------------
    const criadas = [];
    for (let k = 1; k <= n; k++) {
      const correlationID = `${referencia}-p${k}-${Date.now()}`;
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
          comment: `Pedido${combinado ? 's' : ''} ${numeros}${alunos ? ' - ' + alunos : ''} - parcela ${k}/${n}`,
          customer: {
            name: resp.name || 'Responsavel',
            taxID: cpf,
            email: resp.email || undefined,
            phone: telefoneBR(resp.phone) ? '+55' + telefoneBR(resp.phone) : undefined,
          },
        }),
      }, wooviConta);

      const fatias = dividirProporcional(valores[k - 1], pesos);
      const linhas = pedidosGrupo.map((p, i) => ({
        order_id: p.id,
        installment_number: k,
        total_installments: n,
        value: fatias[i],
        due_date: dueDate.slice(0, 10),
        status: 'active',
        attempt: 1,
        gateway: 'woovi',
        gateway_id: correlationID,
        gateway_status: cob.charge?.status || null,
        pix_payload: cob.charge?.brCode || null,
        pix_qr_image: cob.charge?.qrCodeImage || null,
      }));
      await sb('/pix_installments', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(linhas),
      });
      criadas.push({
        numero: k,
        valor: valores[k - 1],
        vencimento: dueDate.slice(0, 10),
        pix_payload: cob.charge?.brCode || null,
        pix_qr_image: cob.charge?.qrCodeImage || null,
      });
    }

    // ---- 6. Irmao que estava num grupo antigo e ficou de fora ---------------
    // Mesmo cuidado do criar-cobranca.js: so' depois das cobrancas novas
    // criadas. As cobrancas antigas ja' cairam no passo 3 (eram as mesmas).
    const gruposAntigos = new Set(pedidosGrupo.map((p) => p.payment_group_id).filter(Boolean));
    for (const gid of gruposAntigos) {
      const deFora = await sb(`/orders?payment_group_id=eq.${q(gid)}&id=not.in.(${idsSql})&select=id`);
      if (!deFora?.length) continue;
      try { await cancelarParcelasPix(deFora.map((o) => o.id), wooviConta); }
      catch (e) { console.error('parcelas do irmao que saiu do grupo', e.causa || e.message); }
      await sb(`/orders?payment_group_id=eq.${q(gid)}&id=not.in.(${idsSql})`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          gateway: null, gateway_id: null, gateway_status: null,
          amount_charged: null, surcharge_amount: 0, installments: 1, payment_method: null,
          pix_payload: null, pix_qr_image: null, checkout_url: null, payment_group_id: null,
        }),
      });
    }

    // ---- 7. Grava no(s) pedido(s) — parcela 1 fica visivel nos campos de sempre
    const primeira = criadas[0];
    const totalPorPedido = dividirProporcional(valorBase, pesos);
    await Promise.all(pedidosGrupo.map((p, i) => sb(`/orders?id=eq.${q(p.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        payment_method: 'pix_parcelado',
        installments: n,
        amount_charged: totalPorPedido[i],
        surcharge_amount: 0,
        gateway: 'woovi',
        gateway_id: null,
        gateway_status: null,
        payment_group_id: groupId,
        pix_payload: primeira.pix_payload,
        pix_qr_image: primeira.pix_qr_image,
        checkout_url: null,
      }),
    })));

    return res.status(200).json({
      ok: true,
      order_ids: pedidosGrupo.map((p) => p.id),
      valor_base_bruto: valorBase0,
      desconto_irmaos: descontoIrmaos,
      acrescimo_parcelamento: acrescimoParcelamento,
      valor_total: valorBase,
      parcelas: criadas.map((c) => ({ numero: c.numero, valor: c.valor, vencimento: c.vencimento })),
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
