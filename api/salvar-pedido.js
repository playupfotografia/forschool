// ============================================================================
// POST /api/salvar-pedido
//
// Cria ou atualiza o pedido do aluno a partir do carrinho.
//
// Por que existe: antes o navegador calculava os precos e mandava o
// total_amount pronto. Quem soubesse mexer no JS do proprio celular podia
// fechar um pedido de R$ 139,90 por R$ 1,00 — e, com a confirmacao automatica
// do gateway, o pedido viraria "pago". Aqui o cliente manda SO o que quer e
// quantos; preco e total saem do banco.
//
// Se ja existe pedido pendente do mesmo aluno no mesmo projeto, ele e
// REESCRITO no lugar — mantendo o mesmo numero (P0038 continua P0038). E' o
// modelo de carrinho de e-commerce: o pedido em aberto e' o carrinho.
//
// Body: { student_id, project_id, kits: {basico:1,...}, avulsos: {uuid: qty} }
// Header: Authorization: Bearer <access_token do Supabase>
// ============================================================================

const { asaas, sb, usuarioDoToken } = require('./_lib.js');

const KIT_RANK = { promo: 3, inter: 2, basico: 1 };
const q = (v) => encodeURIComponent(v);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'Use POST.' });
  }

  try {
    const uid = await usuarioDoToken(req);
    if (!uid) return res.status(401).json({ erro: 'Sessao expirada. Faca login novamente.' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const studentId = body.student_id;
    const projectId = body.project_id || null;
    const kitsPed = body.kits && typeof body.kits === 'object' ? body.kits : {};
    const avPed = body.avulsos && typeof body.avulsos === 'object' ? body.avulsos : {};

    if (!studentId) return res.status(400).json({ erro: 'student_id e obrigatorio.' });

    // ---- 1. O aluno e' mesmo de quem esta pedindo? -------------------------
    const alunos = await sb(`/students?id=eq.${q(studentId)}&select=id,name,school_id,user_id`);
    const aluno = alunos?.[0];
    if (!aluno) return res.status(404).json({ erro: 'Aluno nao encontrado.' });
    if (aluno.user_id !== uid) return res.status(403).json({ erro: 'Esse aluno nao e seu.' });

    // ---- 2. O projeto e' da mesma escola? ---------------------------------
    // Sem isso daria pra passar o projeto de outra escola e pegar preco de la.
    if (projectId) {
      const projs = await sb(`/projects?id=eq.${q(projectId)}&select=id,school_id`);
      const proj = projs?.[0];
      if (!proj || proj.school_id !== aluno.school_id) {
        return res.status(400).json({ erro: 'Projeto invalido para esse aluno.' });
      }
    }

    // ---- 3. Precos do banco (mesmas regras do catalogo) --------------------
    // Kits: os do projeto tem prioridade; sem eles, os da escola.
    let kitsDb = projectId
      ? await sb(`/school_kits?project_id=eq.${q(projectId)}&available=is.true&select=id,kit_type,name,price`)
      : [];
    if (!kitsDb.length) {
      kitsDb = await sb(
        `/school_kits?school_id=eq.${q(aluno.school_id)}&project_id=is.null&available=is.true&select=id,kit_type,name,price`
      );
    }

    // Avulsos: school_prices do projeto tem prioridade; sem elas, as da escola.
    let precosDb = projectId
      ? await sb(`/school_prices?project_id=eq.${q(projectId)}&select=product_id,available,price_with_promo,price_without_promo`)
      : [];
    if (!precosDb.length) {
      precosDb = await sb(
        `/school_prices?school_id=eq.${q(aluno.school_id)}&project_id=is.null&select=product_id,available,price_with_promo,price_without_promo`
      );
    }
    const precoPorProduto = {};
    precosDb.forEach((p) => { precoPorProduto[p.product_id] = p; });

    const produtos = await sb(
      '/products?active=is.true&type=eq.avulso&select=id,name,base_price_with_promo,base_price_without_promo'
    );

    // ---- 4. Monta o pedido com preco do servidor --------------------------
    const kitsFinal = [];
    let total = 0;
    let kitPrincipal = null;

    for (const [tipo, qtdBruta] of Object.entries(kitsPed)) {
      const qtd = Math.max(0, parseInt(qtdBruta, 10) || 0);
      if (!qtd) continue;
      const kit = kitsDb.find((k) => k.kit_type === tipo);
      if (!kit) continue;                       // kit indisponivel: ignora
      const unit = Number(kit.price) || 0;
      kitsFinal.push({ kit_id: kit.id, quantity: qtd, unit_price: unit });
      total += unit * qtd;
      if (!kitPrincipal || (KIT_RANK[tipo] || 0) > (KIT_RANK[kitPrincipal] || 0)) kitPrincipal = tipo;
    }

    // O desconto nos avulsos so vale com o Kit Promocional no carrinho
    const temPromo = kitsFinal.some((k) => {
      const kit = kitsDb.find((x) => x.id === k.kit_id);
      return kit && kit.kit_type === 'promo';
    });

    const itensFinal = [];
    for (const [pid, qtdBruta] of Object.entries(avPed)) {
      const qtd = Math.max(0, parseInt(qtdBruta, 10) || 0);
      if (!qtd) continue;
      const prod = produtos.find((p) => p.id === pid);
      if (!prod) continue;
      const sp = precoPorProduto[pid];
      if (sp && sp.available === false) continue;   // indisponivel: ignora
      const unit = Number(
        temPromo
          ? (sp?.price_with_promo ?? prod.base_price_with_promo)
          : (sp?.price_without_promo ?? prod.base_price_without_promo)
      ) || 0;
      itensFinal.push({ product_id: pid, quantity: qtd, unit_price: unit, discount_applied: temPromo });
      total += unit * qtd;
    }

    if (!kitsFinal.length && !itensFinal.length) {
      return res.status(400).json({ erro: 'Carrinho vazio.' });
    }
    total = Math.round(total * 100) / 100;

    // ---- 5. Reaproveita o pedido pendente (mantem o numero) ---------------
    let filtro = `/orders?student_id=eq.${q(studentId)}&payment_status=eq.pending`;
    if (projectId) filtro += `&project_id=eq.${q(projectId)}`;
    const pendentes = await sb(`${filtro}&select=id,order_number,gateway,gateway_id&order=created_at.desc`);
    const existente = pendentes?.[0];

    let orderId, orderNumber;

    if (existente) {
      orderId = existente.id;
      orderNumber = existente.order_number;

      // O valor mudou, entao a cobranca antiga nao vale mais. Cancelar antes
      // de regravar: senao sobraria um QR pagavel com o valor velho.
      if (existente.gateway === 'asaas' && existente.gateway_id) {
        try {
          await asaas(`/payments/${existente.gateway_id}`, { method: 'DELETE' });
        } catch (e) {
          if (e.status !== 404) {
            console.error('cancelar cobranca', e.message);
            return res.status(502).json({ erro: 'Nao consegui atualizar a cobranca. Tente de novo.' });
          }
        }
      }

      await sb(`/order_items?order_id=eq.${q(orderId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      await sb(`/order_kits?order_id=eq.${q(orderId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });

      await sb(`/orders?id=eq.${q(orderId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          kit_type: kitPrincipal,
          total_amount: total,
          gateway: null, gateway_id: null, gateway_status: null,
          amount_charged: null, surcharge_amount: 0, installments: 1,
          pix_payload: null, pix_qr_image: null, checkout_url: null,
        }),
      });
    } else {
      const criado = await sb('/orders', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          student_id: studentId,
          user_id: uid,
          school_id: aluno.school_id,
          project_id: projectId,
          kit_type: kitPrincipal,
          total_amount: total,
          payment_status: 'pending',
          source: 'parent',
        }),
      });
      orderId = criado?.[0]?.id;
      orderNumber = criado?.[0]?.order_number;
      if (!orderId) return res.status(500).json({ erro: 'Nao consegui criar o pedido.' });
    }

    // ---- 6. Itens ----------------------------------------------------------
    if (kitsFinal.length) {
      await sb('/order_kits', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(kitsFinal.map((k) => ({ order_id: orderId, ...k }))),
      });
    }
    if (itensFinal.length) {
      await sb('/order_items', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(itensFinal.map((i) => ({ order_id: orderId, ...i }))),
      });
    }

    return res.status(200).json({
      ok: true,
      order_id: orderId,
      order_number: orderNumber,
      total_amount: total,
      atualizado: !!existente,
    });
  } catch (err) {
    console.error('salvar-pedido', err);
    return res.status(err.status && err.status < 500 ? 400 : 500).json({
      erro: err.message || 'Erro ao salvar o pedido.',
    });
  }
};
