// ============================================================================
// POST /api/pedido-publico
//
// Alimenta a pagina publica /pagar/<token> (pagamento.html) — o link que o
// admin gera pra responsavel que nao consegue usar o portal. Antes essa pagina
// so' sabia mostrar o PIX manual (chave fixa) e cartao a vista; agora ela
// mostra PIX automatico (Woovi) e cartao de credito a vista e parcelado (ate o
// maximo do projeto, com as mesmas taxas e acrescimos do portal).
//
// Quem decide o que existe e quanto custa e' este servidor (mesma cadeia
// projeto -> geral de criar-cobranca.js); a pagina so' desenha. Preco nunca
// vem do navegador — quem cobra de verdade continua sendo criar-cobranca.js /
// criar-parcelamento-pix.js, que revalidam tudo.
//
// Body: { token }   (sem login — o token do pedido e' a autorizacao)
// ============================================================================

const { sb, valorComTaxa, calcularAcrescimoParcelamento } = require('./_lib.js');

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
    const token = String(body.token || '').trim();
    if (!token || token.length < 8) return res.status(400).json({ erro: 'Link invalido.' });

    const peds = await sb(
      `/orders?payment_link_token=eq.${q(token)}&select=` +
      'id,order_number,total_amount,payment_status,payment_method,installments,amount_charged,gateway,gateway_id,' +
      'pix_payload,pix_qr_image,checkout_url,has_paid_installment,project_id,is_test,' +
      'users(cpf),students(name,class:school_classes(name,year:school_years(name))),school:schools(name),project:projects(name),' +
      'items:order_items(quantity,variant_name,product:products(name)),kits:order_kits(quantity,kit:school_kits(name))'
    );
    const p = peds?.[0];
    if (!p) return res.status(404).json({ erro: 'Pedido nao encontrado.' });

    const pedido = {
      order_id: p.id,
      order_number: p.order_number,
      total_amount: Number(p.total_amount) || 0,
      payment_status: p.payment_status,
      student_name: p.students?.name || '',
      turma: [p.students?.class?.year?.name, p.students?.class?.name].filter(Boolean).join(' — '),
      school_name: p.school?.name || '',
      project_name: p.project?.name || '',
      itens: [
        ...(p.kits || []).map((k) => ({ nome: k.kit?.name || 'Kit', quantidade: k.quantity || 1 })),
        ...(p.items || []).map((i) => ({ nome: i.product?.name || '—', quantidade: i.quantity || 1, variante: i.variant_name || null })),
      ],
    };

    if (p.payment_status === 'paid') return res.status(200).json({ ok: true, pago: true, pedido });
    if (p.payment_status === 'cancelled' || p.payment_status === 'refunded') {
      return res.status(200).json({ ok: true, cancelado: true, pedido });
    }

    // ---- Configuracao (projeto manda, depois o geral) ----------------------
    const cfg = (await sb(
      '/app_settings?id=eq.1&select=pix_key,pix_gateway,pay_pix_enabled,pay_credit_enabled,surcharge_mode,max_installments,min_installment_value,' +
      'card_fee_percent,card_fee_percent_installment,card_fee_fixed,anticipation_enabled,anticipation_fee_percent,anticipation_fee_percent_installment'
    ))?.[0] || {};
    let proj = null;
    if (p.project_id) {
      proj = (await sb(
        `/projects?id=eq.${q(p.project_id)}&select=pix_mode,max_installments,surcharge_mode`
      ))?.[0] || null;
    }

    const total = pedido.total_amount;
    // Mesma cadeia projeto -> geral do portal/criar-cobranca: o pix_mode do projeto
    // manda; em branco vale o interruptor geral.
    const pixAuto = proj?.pix_mode === 'automatico' ? true : proj?.pix_mode === 'manual' ? false : (cfg.pay_pix_enabled !== false);
        const semCpf = !String(p.users?.cpf || '').replace(/\D/g, '');
    const gatewayOk = !semCpf;   // o gateway (Woovi/Asaas) exige o CPF do pagador

    const acrescimo = p.project_id ? await calcularAcrescimoParcelamento([p.id], p.project_id) : 0;
    const base = arred(total + acrescimo);   // base de cartao e de PIX parcelado (migration_061)

    const opcoes = { pix_auto: null, credito: [] };

    // PIX automatico (Woovi ou Asaas, conforme o motor configurado): QR gerado na
    // hora e confirmado sozinho. Este link NAO oferece mais o PIX manual (chave
    // fixa) — pedido do Daniel em 20/10/2026. PIX parcelado fica so' no portal.
    if (pixAuto && gatewayOk) opcoes.pix_auto = { valor: arred(total) };

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
    // sem criar outra. PIX parcelado do portal fica de fora (tem fluxo proprio).
    let cobranca = null;
    if (p.payment_method !== 'pix_parcelado' && (p.pix_payload || p.pix_qr_image || p.checkout_url)) {
      cobranca = {
        metodo: p.payment_method || null,
        parcelas: p.installments || 1,
        valor: arred(p.amount_charged ?? total),
        pix_payload: p.pix_payload || null,
        pix_qr_image: p.pix_qr_image || null,
        checkout_url: p.checkout_url || null,
      };
    }

    return res.status(200).json({ ok: true, pedido, opcoes, cobranca, sem_cpf: semCpf });
  } catch (err) {
    console.error('pedido-publico', err);
    return res.status(500).json({ erro: 'Nao consegui carregar o pedido. Tente de novo em instantes.' });
  }
};
