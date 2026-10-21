// ============================================================================
// POST /api/pedido-publico
//
// Alimenta a pagina publica /pagar/<token> (pagamento.html) — o link que o
// admin gera pra responsavel que nao consegue usar o portal. Mostra PIX
// automatico (Woovi) e cartao de credito a vista e parcelado (ate o maximo do
// projeto, com as mesmas taxas e acrescimos do portal).
//
// LINK COMBINADO (21/10/2026): o admin pode juntar 2+ pedidos do MESMO
// responsavel e projeto num link so': /pagar/<token1>~<token2>. Cada pedido
// tem o seu proprio token (autoriza so' ele); a pagina soma os valores e paga
// tudo numa cobranca (api/criar-cobranca.js, mesmo caminho do "pagar junto" do
// portal, com o desconto de irmaos do projeto, se houver).
//
// Quem decide o que existe e quanto custa e' este servidor (mesma cadeia
// projeto -> geral de criar-cobranca.js); a pagina so' desenha. Preco nunca
// vem do navegador — quem cobra de verdade e' criar-cobranca.js, que
// revalida tudo.
//
// Body: { tokens: [t1, t2...] }  (ou { token })   — sem login: o token e' a autorizacao
// ============================================================================

const { sb, valorComTaxa, calcularAcrescimoParcelamento, calcularDescontoIrmaos } = require('./_lib.js');

const q = (v) => encodeURIComponent(v);
const arred = (n) => Math.round(Number(n) * 100) / 100;

function maiorParcelamentoOk(valor, maxParc, minParc) {
  const out = [];
  for (let n = 2; n <= Math.min(maxParc, 12); n++) {
    if (Math.ceil((valor / n) * 100) / 100 >= minParc) out.push(n);
  }
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'Use POST.' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const tokens = [...new Set((Array.isArray(body.tokens) ? body.tokens : [body.token])
      .map((t) => String(t || '').trim()).filter(Boolean))].slice(0, 6);
    if (!tokens.length || tokens.some((t) => t.length < 8)) return res.status(400).json({ erro: 'Link invalido.' });

    const brutos = await sb(
      `/orders?payment_link_token=in.(${tokens.map(q).join(',')})&select=` +
      'id,order_number,total_amount,payment_status,payment_method,installments,amount_charged,gateway,gateway_id,' +
      'pix_payload,pix_qr_image,checkout_url,has_paid_installment,project_id,user_id,is_test,payment_link_token,' +
      'users(cpf),students(name,class:school_classes(name,year:school_years(name))),school:schools(name),project:projects(name),' +
      'items:order_items(quantity,variant_name,product:products(name)),kits:order_kits(quantity,kit:school_kits(name))'
    );
    if (!brutos || brutos.length !== tokens.length) return res.status(404).json({ erro: 'Pedido nao encontrado.' });
    // mantem a ordem dos tokens do link
    const peds = tokens.map((t) => brutos.find((o) => o.payment_link_token === t));
    const p = peds[0];
    const grupo = peds.length > 1;
    if (grupo) {
      const mesmoResp = peds.every((o) => o.user_id && o.user_id === p.user_id);
      const mesmoProj = peds.every((o) => o.project_id && o.project_id === p.project_id);
      if (!mesmoResp || !mesmoProj) return res.status(400).json({ erro: 'Estes pedidos nao podem ser pagos juntos.' });
    }

    const resumo = (o) => ({
      order_id: o.id,
      order_number: o.order_number,
      total_amount: Number(o.total_amount) || 0,
      payment_status: o.payment_status,
      student_name: o.students?.name || '',
      turma: [o.students?.class?.year?.name, o.students?.class?.name].filter(Boolean).join(' — '),
      itens: [
        ...(o.kits || []).map((k) => ({ nome: k.kit?.name || 'Kit', quantidade: k.quantity || 1 })),
        ...(o.items || []).map((i) => ({ nome: i.product?.name || '—', quantidade: i.quantity || 1, variante: i.variant_name || null })),
      ],
    });
    const lista = peds.map(resumo);
    const total0 = arred(lista.reduce((s, o) => s + o.total_amount, 0));

    const pedido = {
      ...lista[0],
      total_amount: total0,
      school_name: p.school?.name || '',
      project_name: p.project?.name || '',
    };
    const extra = grupo ? { grupo: lista, order_ids: lista.map((o) => o.order_id) } : { order_ids: [p.id] };

    if (peds.every((o) => o.payment_status === 'paid')) return res.status(200).json({ ok: true, pago: true, pedido, ...extra });
    if (peds.some((o) => o.payment_status === 'cancelled' || o.payment_status === 'refunded')) {
      return res.status(200).json({ ok: true, cancelado: true, pedido, ...extra });
    }
    if (peds.some((o) => o.payment_status === 'paid')) {
      return res.status(200).json({ ok: true, parcial_pago: true, pedido, ...extra });
    }

    // ---- Configuracao (projeto manda, depois o geral) ----------------------
    const cfg = (await sb(
      '/app_settings?id=eq.1&select=pix_key,pix_gateway,pay_pix_enabled,pay_credit_enabled,surcharge_mode,max_installments,min_installment_value,' +
      'card_fee_percent,card_fee_percent_installment,card_fee_fixed,anticipation_enabled,anticipation_fee_percent,anticipation_fee_percent_installment'
    ))?.[0] || {};
    let proj = null;
    if (p.project_id) {
      proj = (await sb(
        `/projects?id=eq.${q(p.project_id)}&select=pix_mode,max_installments,surcharge_mode,sibling_discount_mode,sibling_discount_value`
      ))?.[0] || null;
    }

    // Mesma cadeia projeto -> geral do portal/criar-cobranca: o pix_mode do projeto
    // manda; em branco vale o interruptor geral.
    const pixAuto = proj?.pix_mode === 'automatico' ? true : proj?.pix_mode === 'manual' ? false : (cfg.pay_pix_enabled !== false);
    const semCpf = !String(p.users?.cpf || '').replace(/\D/g, '');
    const gatewayOk = !semCpf;   // o gateway (Woovi/Asaas) exige o CPF do pagador

    // Desconto de irmaos (so' em pagamento combinado, e so' se o projeto configurou) —
    // mesma conta de criar-cobranca.js.
    const desconto = grupo ? calcularDescontoIrmaos(total0, proj) : 0;
    const valorPix = arred(total0 - desconto);
    const acrescimo = p.project_id ? await calcularAcrescimoParcelamento(peds.map((o) => o.id), p.project_id) : 0;
    const base = arred(valorPix + acrescimo);   // base do cartao (migration_061)

    const opcoes = { pix_auto: null, credito: [] };

    // PIX automatico (Woovi ou Asaas, conforme o motor configurado): QR gerado na
    // hora e confirmado sozinho. Este link NAO oferece o PIX manual (chave fixa).
    // PIX parcelado fica so' no portal.
    if (pixAuto && gatewayOk) opcoes.pix_auto = { valor: valorPix };

    // Cartao de credito (sempre Asaas): a vista e parcelado ate o maximo
    if (cfg.pay_credit_enabled !== false && gatewayOk) {
      const repassa = (proj?.surcharge_mode || cfg.surcharge_mode || 'pass_on') !== 'absorb';
      const maxParc = parseInt(proj?.max_installments, 10) || parseInt(cfg.max_installments, 10) || 1;
      const minParc = Number(cfg.min_installment_value) || 0;
      const antecipa = cfg.anticipation_enabled === true;
      const calc = (parcelas) => {
        if (!repassa) return base;
        let pct = Number(parcelas > 1 ? cfg.card_fee_percent_installment : cfg.card_fee_percent) || 0;
        if (antecipa) pct += Number(parcelas > 1 ? cfg.anticipation_fee_percent_installment : cfg.anticipation_fee_percent) || 0;
        return valorComTaxa(base, pct, cfg.card_fee_fixed);
      };
      const v1 = calc(1);
      opcoes.credito.push({ n: 1, total: arred(v1), parcela: arred(v1) });
      const v2 = calc(2);
      for (const n of maiorParcelamentoOk(v2, maxParc, minParc)) {
        opcoes.credito.push({ n, total: arred(v2), parcela: Math.ceil((v2 / n) * 100) / 100 });
      }
    }

    // ---- Cobranca ja gerada (PIX automatico ou cartao): reabrir o link mostra ela,
    // sem criar outra. Num grupo, a cobranca e' a mesma nos pedidos (valor = soma).
    let cobranca = null;
    if (p.payment_method !== 'pix_parcelado' && (p.pix_payload || p.pix_qr_image || p.checkout_url)) {
      cobranca = {
        metodo: p.payment_method || null,
        parcelas: p.installments || 1,
        valor: arred(peds.reduce((s, o) => s + (Number(o.amount_charged ?? o.total_amount) || 0), 0)),
        pix_payload: p.pix_payload || null,
        pix_qr_image: p.pix_qr_image || null,
        checkout_url: p.checkout_url || null,
      };
    }

    return res.status(200).json({ ok: true, pedido, opcoes, cobranca, sem_cpf: semCpf, desconto, ...extra });
  } catch (err) {
    console.error('pedido-publico', err);
    return res.status(500).json({ erro: 'Nao consegui carregar o pedido. Tente de novo em instantes.' });
  }
};
