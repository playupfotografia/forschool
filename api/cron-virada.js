// ============================================================================
// GET /api/cron-virada
//
// Robo diario (Vercel Cron, ver "crons" em vercel.json) que aplica a "virada"
// programada de um projeto (migration_067): troca de preco numa data, fim do
// PIX parcelado e pedidos pendentes recalculados.
//
// Autenticado por CRON_SECRET, igual ao cron-parcelas-atrasadas.
//
// Teste sem gravar nada:  GET /api/cron-virada?dry=1&forcar=1
//   (dry=1 so' relata; forcar=1 trata a virada como vencida mesmo antes da data
//   — so' vale junto com dry=1, pra ninguem aplicar antes da hora sem querer.)
//
// Idempotente: cada passo pode rodar de novo sem estragar nada (o total do
// pedido e' sempre recalculado a partir dos itens, nunca somado por cima). So'
// marca virada_aplicada_em quando TUDO deu certo; se algo falhar, o robo tenta
// de novo no dia seguinte.
// ============================================================================

const { asaas, woovi, sb, cancelarParcelasPix } = require('./_lib.js');

const q = (v) => encodeURIComponent(v);
const arred = (n) => Math.round(Number(n) * 100) / 100;

async function cancelarCobranca(pedido, conta) {
  if (pedido.gateway === 'asaas' && pedido.gateway_id) {
    try { await asaas(`/payments/${pedido.gateway_id}`, { method: 'DELETE' }); }
    catch (e) { if (e.status !== 404) throw e; }
  } else if (pedido.gateway === 'woovi' && pedido.gateway_id) {
    try { await woovi(`/api/v1/charge/${pedido.gateway_id}`, { method: 'DELETE' }, conta || null); }
    catch (e) { if (e.status !== 404) throw e; }
  }
}

module.exports = async (req, res) => {
  const auth = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ erro: 'Nao autorizado.' });
  }

  const dry = req.query?.dry === '1';
  const forcar = dry && req.query?.forcar === '1';
  const relatorio = { dry, projetos: [] };

  try {
    const projetos = await sb(
      '/projects?virada_em=not.is.null&virada_aplicada_em=is.null' +
      '&select=id,name,virada_em,virada_config,delivery_fee,woovi_conta,pix_parcelas'
    );

    for (const p of (projetos || [])) {
      if (!forcar && Date.parse(p.virada_em) > Date.now()) continue;

      const cfg = p.virada_config || {};
      const precos = Array.isArray(cfg.precos) ? cfg.precos : [];
      const novoPreco = {};
      const novoAcrescimo = {};
      precos.forEach((x) => {
        if (x.product_id && Number(x.price) > 0) novoPreco[x.product_id] = Number(x.price);
        if (x.product_id && x.pix_parcela_acrescimo !== undefined) novoAcrescimo[x.product_id] = Number(x.pix_parcela_acrescimo) || 0;
      });
      const taxa = cfg.taxa_nos_pendentes === false ? 0 : (Number(p.delivery_fee) || 0);
      const rp = { projeto: p.name, precos: precos.length, pendentes: [], erros: [] };
      relatorio.projetos.push(rp);

      // ---- 1. Pedidos pendentes: recalcula e derruba a cobranca antiga ------
      const pendentes = await sb(
        `/orders?project_id=eq.${q(p.id)}&payment_status=eq.pending&has_paid_installment=eq.false` +
        '&is_test=not.is.true&select=id,order_number,total_amount,gateway,gateway_id,payment_group_id,' +
        'payment_method,delivery_method,delivery_fee'
      );

      for (const o of (pendentes || [])) {
        try {
          const itens = await sb(`/order_items?order_id=eq.${q(o.id)}&select=id,product_id,quantity,unit_price,variant_id,variant_name`);
          const kits = await sb(`/order_kits?order_id=eq.${q(o.id)}&select=quantity,unit_price`);

          let soma = 0;
          const trocas = [];
          for (const it of (itens || [])) {
            let unit = Number(it.unit_price) || 0;
            // item com variacao tem preco proprio da variacao — nao mexe
            if (novoPreco[it.product_id] && !it.variant_id && !it.variant_name && unit !== novoPreco[it.product_id]) {
              trocas.push({ id: it.id, unit_price: novoPreco[it.product_id] });
              unit = novoPreco[it.product_id];
            }
            soma += unit * (it.quantity || 1);
          }
          for (const k of (kits || [])) soma += (Number(k.unit_price) || 0) * (k.quantity || 1);

          const metodo = taxa > 0 ? 'motoboy' : (o.delivery_method || 'escola');
          const feeNovo = taxa > 0 ? taxa : (Number(o.delivery_fee) || 0);
          const totalNovo = arred(soma + feeNovo);

          rp.pendentes.push({
            pedido: o.order_number, de: Number(o.total_amount), para: totalNovo,
            cobrancaCancelada: !!o.gateway_id,
          });
          if (dry) continue;

          // cancela a cobranca antiga (QR/parcelas) — senao daria pra pagar o valor velho
          await cancelarCobranca(o, p.woovi_conta);
          let irmaos = [];
          if (o.payment_group_id) {
            irmaos = (await sb(`/orders?payment_group_id=eq.${q(o.payment_group_id)}&id=neq.${q(o.id)}&select=id`) || []).map((x) => x.id);
          }
          await cancelarParcelasPix([o.id, ...irmaos], p.woovi_conta || null);
          if (o.payment_group_id) {
            await sb(`/orders?payment_group_id=eq.${q(o.payment_group_id)}&id=neq.${q(o.id)}`, {
              method: 'PATCH', headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({
                gateway: null, gateway_id: null, gateway_status: null, amount_charged: null,
                surcharge_amount: 0, installments: 1, payment_method: null,
                pix_payload: null, pix_qr_image: null, checkout_url: null, payment_group_id: null,
              }),
            });
          }

          for (const t of trocas) {
            await sb(`/order_items?id=eq.${q(t.id)}`, {
              method: 'PATCH', headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ unit_price: t.unit_price }),
            });
          }
          await sb(`/orders?id=eq.${q(o.id)}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              total_amount: totalNovo,
              delivery_method: metodo,
              delivery_fee: feeNovo,
              gateway: null, gateway_id: null, gateway_status: null, amount_charged: null,
              surcharge_amount: 0, installments: 1,
              ...(o.payment_method === 'pix_parcelado' ? { payment_method: null } : {}),
              pix_payload: null, pix_qr_image: null, checkout_url: null, payment_group_id: null,
            }),
          });
        } catch (e) {
          rp.erros.push(`${o.order_number}: ${e.causa || e.message}`);
          console.error('cron-virada pedido', o.order_number, e.causa || e.message);
        }
      }

      if (dry) continue;

      // ---- 2. Precos do projeto ---------------------------------------------
      try {
        for (const [productId, price] of Object.entries(novoPreco)) {
          const campos = { price_with_promo: price, price_without_promo: price };
          if (novoAcrescimo[productId] !== undefined) campos.pix_parcela_acrescimo = novoAcrescimo[productId];
          await sb(`/school_prices?project_id=eq.${q(p.id)}&product_id=eq.${q(productId)}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify(campos),
          });
        }
        // ---- 3. Campos do projeto (PIX parcelado etc.) ----------------------
        // cfg.projeto = { pix_parcelas, pix_parcelas_ate, pix_venc_parcela2/3/4 }
        // — so' estas colunas sao aceitas; null liga/desliga de verdade (ex:
        // pix_parcelas null = o PIX parcelado acaba). Sem cfg.projeto, vale o
        // formato antigo (pix_parcelas / desligar_pix_parcelado).
        const PERMITIDOS = ['pix_parcelas', 'pix_parcelas_ate', 'pix_venc_parcela2', 'pix_venc_parcela3', 'pix_venc_parcela4'];
        const camposProj = {};
        if (cfg.projeto && typeof cfg.projeto === 'object') {
          PERMITIDOS.forEach((k) => { if (k in cfg.projeto) camposProj[k] = cfg.projeto[k] === '' ? null : cfg.projeto[k]; });
        } else if ('pix_parcelas' in cfg || cfg.desligar_pix_parcelado !== false) {
          camposProj.pix_parcelas = 'pix_parcelas' in cfg ? (Number(cfg.pix_parcelas) || null) : null;
        }
        if (Object.keys(camposProj).length) {
          await sb(`/projects?id=eq.${q(p.id)}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify(camposProj),
          });
        }
        // ---- 4. Modelos de WhatsApp (globais) -------------------------------
        if (cfg.whatsapp?.sem_pedido && cfg.whatsapp?.pendente) {
          await sb('/app_settings?id=eq.1', {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              contact_msg_sem_pedido: cfg.whatsapp.sem_pedido,
              contact_msg_pendente: cfg.whatsapp.pendente,
            }),
          });
        }
      } catch (e) {
        rp.erros.push(`projeto: ${e.message}`);
        console.error('cron-virada projeto', p.name, e.message);
      }

      // ---- 5. So' marca como aplicada se nada falhou ------------------------
      // Se a config traz "depois" (proxima virada, ex: 3 lotes de preco), ela vira
      // a virada pendente; senao o projeto fica marcado como concluido.
      if (!rp.erros.length) {
        if (cfg.depois?.em) {
          const { em, ...cfgProx } = cfg.depois;
          await sb(`/projects?id=eq.${q(p.id)}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ virada_em: em, virada_config: cfgProx, virada_aplicada_em: null }),
          });
          rp.proxima = em;
        } else {
          await sb(`/projects?id=eq.${q(p.id)}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ virada_aplicada_em: new Date().toISOString() }),
          });
        }
        rp.aplicada = true;
      }
    }

    return res.status(200).json(relatorio);
  } catch (err) {
    console.error('cron-virada', err);
    return res.status(500).json({ erro: err.message, relatorio });
  }
};
