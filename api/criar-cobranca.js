// ============================================================================
// POST /api/criar-cobranca
//
// Cria a cobranca no Asaas para um pedido ja existente e devolve ao portal o
// que ele precisa mostrar (copia-e-cola do PIX, QR, ou URL do checkout).
//
// Regra de ouro: o valor NUNCA vem do navegador. Lemos o pedido e as taxas do
// banco com service_role e recalculamos aqui. O que o cliente manda e' apenas
// qual pedido, qual metodo e quantas parcelas.
//
// Body: { order_id, method: 'pix'|'credito'|'debito', installments?: 1|2 }
// ============================================================================

const { asaas, sumup, sb, usuarioDoToken, valorComTaxa, apenasDigitos, telefoneBR, emDias, env } = require('./_lib.js');

const BILLING = { pix: 'PIX', credito: 'CREDIT_CARD', debito: 'DEBIT_CARD' };
const METODO_ORDERS = { pix: 'pix', credito: 'cartao_1x', debito: 'cartao_debito' };

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'Use POST.' });
  }

  try {
    // Falamos com o banco por service_role, que ignora RLS — sem esta checagem
    // qualquer um que adivinhasse um id geraria cobranca pro pedido alheio.
    const uid = await usuarioDoToken(req);
    if (!uid) return res.status(401).json({ erro: 'Sessao expirada. Faca login novamente.' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const orderId = body.order_id;
    const metodo = String(body.method || '').toLowerCase();
    let parcelas = parseInt(body.installments, 10) || 1;

    if (!orderId) return res.status(400).json({ erro: 'order_id e obrigatorio.' });
    if (!BILLING[metodo]) return res.status(400).json({ erro: 'Metodo invalido.' });

    // ---- 1. Pedido + responsavel + aluno -----------------------------------
    const pedidos = await sb(
      `/orders?id=eq.${encodeURIComponent(orderId)}&select=` +
      'id,order_number,total_amount,payment_status,gateway_id,student_id,' +
      'user_id,users(name,email,cpf,phone),students(name)'
    );
    const pedido = pedidos?.[0];
    if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado.' });
    if (pedido.user_id && pedido.user_id !== uid) {
      return res.status(403).json({ erro: 'Esse pedido nao e seu.' });
    }
    if (pedido.payment_status === 'paid') {
      return res.status(409).json({ erro: 'Esse pedido ja esta pago.' });
    }

    const valorBase = Number(pedido.total_amount) || 0;
    if (valorBase <= 0) return res.status(400).json({ erro: 'Pedido sem valor.' });

    // ---- 2. Configuracoes (taxas e regras) ---------------------------------
    const cfgs = await sb(
      '/app_settings?id=eq.1&select=' +
      'card_fee_percent,card_fee_percent_installment,card_fee_fixed,' +
      'debit_fee_percent,debit_fee_fixed,surcharge_mode,' +
      'anticipation_enabled,anticipation_fee_percent,anticipation_fee_percent_installment,' +
      'pay_pix_enabled,pay_credit_enabled,pay_debit_enabled,' +
      'min_installment_value,max_installments'
    );
    const cfg = cfgs?.[0];
    if (!cfg) return res.status(500).json({ erro: 'app_settings nao configurado.' });

    const habilitado = {
      pix: cfg.pay_pix_enabled !== false,
      credito: cfg.pay_credit_enabled !== false,
      debito: cfg.pay_debit_enabled === true,
    };
    if (!habilitado[metodo]) {
      return res.status(400).json({ erro: 'Esse metodo de pagamento nao esta habilitado.' });
    }

    // ---- 3. Quanto cobrar ---------------------------------------------------
    const repassa = (cfg.surcharge_mode || 'pass_on') !== 'absorb';
    const maxParc = parseInt(cfg.max_installments, 10) || 1;
    const minParc = Number(cfg.min_installment_value) || 0;

    if (metodo !== 'credito') parcelas = 1;
    if (parcelas < 1) parcelas = 1;
    if (parcelas > maxParc) {
      return res.status(400).json({ erro: `Maximo de ${maxParc}x.` });
    }

    // Antecipacao: soma ao percentual do cartao de credito quando ligada.
    // Nao vale pra PIX (cai na hora) nem pra debito (cai em 3 dias).
    const antecipa = cfg.anticipation_enabled === true;
    let valorCobrado = valorBase;
    if (repassa && metodo !== 'pix') {
      let pct = Number(
        metodo === 'debito'
          ? cfg.debit_fee_percent
          : (parcelas > 1 ? cfg.card_fee_percent_installment : cfg.card_fee_percent)
      ) || 0;
      if (antecipa && metodo === 'credito') {
        pct += Number(
          parcelas > 1 ? cfg.anticipation_fee_percent_installment : cfg.anticipation_fee_percent
        ) || 0;
      }
      const fixa = metodo === 'debito' ? cfg.debit_fee_fixed : cfg.card_fee_fixed;
      valorCobrado = valorComTaxa(valorBase, pct, fixa);
    }

    // Parcela minima — revalidado aqui, nao so' na tela
    if (parcelas > 1) {
      const parcela = Math.ceil((valorCobrado / parcelas) * 100) / 100;
      if (parcela < minParc) {
        return res.status(400).json({
          erro: `Parcela de R$ ${parcela.toFixed(2)} fica abaixo do minimo de R$ ${minParc.toFixed(2)}.`,
        });
      }
    }

    const acrescimo = Math.round((valorCobrado - valorBase) * 100) / 100;

    // ---- 4. Cobranca no gateway ---------------------------------------------
    // O Pix pode ir pra SumUp (Pix sem taxa na conta SumUp Bank) em vez do
    // Asaas. Quem decide e' a variavel PIX_GATEWAY na Vercel: sem ela, tudo
    // continua no Asaas exatamente como antes. Cartao e debito NUNCA saem do
    // Asaas — a SumUp cobra 5,99% a vista e 13,99% em 2x.
    const aluno = pedido.students?.name || '';
    const descricao = `Pedido ${pedido.order_number}${aluno ? ' - ' + aluno : ''}`;
    const pixNaSumUp = metodo === 'pix' && process.env.PIX_GATEWAY === 'sumup';

    let gatewayUsado, gatewayId, gatewayStatus;
    let pixPayload = null, pixQr = null, checkoutUrl = null, vencimento = null;

    if (pixNaSumUp) {
      const site = (process.env.SITE_URL || 'https://forschool.playupfotografia.com.br').replace(/\/$/, '');

      const checkout = await sumup('/v0.1/checkouts', {
        method: 'POST',
        body: JSON.stringify({
          // A SumUp exige referencia unica: repetir o id do pedido faz a
          // segunda tentativa ser recusada com "already exists". Como o pedido
          // pendente E' o carrinho, ele volta aqui toda vez que o pai mexe no
          // carrinho ou tenta de novo — por isso o sufixo. O webhook recorta o
          // id de volta pelo "_".
          checkout_reference: `${pedido.id}_${Date.now()}`,
          amount: valorCobrado,
          currency: 'BRL',
          merchant_code: env('SUMUP_MERCHANT_CODE'),
          description: descricao,
          // E' assim que se assina o webhook na SumUp: nao ha cadastro de URL
          // no painel, o aviso vai pra ca' por cobranca.
          return_url: `${site}/api/sumup-webhook`,
        }),
      });

      // Processar como Pix devolve o copia-e-cola e o QR na propria resposta
      // ("artifacts"), sem redirecionar o pai pra pagina nenhuma.
      const processado = await sumup(`/v0.1/checkouts/${checkout.id}`, {
        method: 'PUT',
        body: JSON.stringify({ payment_type: 'pix' }),
      });

      // Os artefatos vem aninhados em "pix", e a chave e' "artefacts" (com E).
      // Confirmado na resposta real de producao: a sandbox recusa Pix, entao
      // esse formato nao aparecia em teste nenhum.
      const artefatos = processado.pix?.artefacts || processado.pix?.artifacts
        || processado.artefacts || processado.artifacts || [];

      // "code" traz o copia-e-cola. O "barcode" repete o mesmo texto no
      // content dele, entao serve de reserva se o "code" nao vier.
      pixPayload = artefatos.find((a) => a?.name === 'code')?.content
        || artefatos.find((a) => String(a?.content || '').startsWith('000201'))?.content
        || null;

      if (!pixPayload) {
        console.error('sumup pix sem copia-e-cola:', JSON.stringify(processado).slice(0, 1000));
        throw new Error('A SumUp nao devolveu o codigo do Pix.');
      }

      // A imagem do QR fica numa URL da propria API, que exige o nosso Bearer
      // token: jogar essa URL no <img> do portal daria 401 no celular do pai.
      // Baixamos aqui e embutimos em base64, como o Asaas ja entrega pronto.
      const urlQr = artefatos.find((a) => a?.name === 'barcode')?.location;
      if (urlQr) {
        try {
          const img = await fetch(urlQr, {
            headers: { Authorization: 'Bearer ' + env('SUMUP_API_KEY') },
          });
          if (img.ok) {
            const tipo = img.headers.get('content-type') || 'image/jpeg';
            const b64 = Buffer.from(await img.arrayBuffer()).toString('base64');
            pixQr = `data:${tipo};base64,${b64}`;
          } else {
            console.error('sumup qr HTTP ' + img.status);
          }
        } catch (e) {
          // Sem a imagem o pai ainda paga pelo copia-e-cola — nao vale derrubar
          // a cobranca inteira por causa do QR.
          console.error('sumup qr', e.message);
        }
      }

      gatewayUsado = 'sumup';
      gatewayId = checkout.id;
      gatewayStatus = processado.status || checkout.status || null;
      vencimento = processado.valid_until || checkout.valid_until || null;
    } else {
      // Cliente no Asaas (reaproveita pelo CPF)
      const resp = pedido.users || {};
      const cpf = apenasDigitos(resp.cpf);
      if (!cpf) {
        return res.status(400).json({
          erro: 'O responsavel esta sem CPF no cadastro, e o Asaas exige o CPF do pagador.',
        });
      }

      let clienteId = null;
      const busca = await asaas(`/customers?cpfCnpj=${cpf}&limit=1`);
      if (busca?.data?.length) {
        clienteId = busca.data[0].id;
      } else {
        const novo = await asaas('/customers', {
          method: 'POST',
          body: JSON.stringify({
            name: resp.name || 'Responsavel',
            cpfCnpj: cpf,
            email: resp.email || undefined,
            mobilePhone: telefoneBR(resp.phone),
            externalReference: pedido.user_id || undefined,
            notificationDisabled: true,   // quem avisa o pai e' o portal, nao o Asaas
          }),
        });
        clienteId = novo.id;
      }

      const cobranca = {
        customer: clienteId,
        billingType: BILLING[metodo],
        value: valorCobrado,
        dueDate: emDias(3),
        description: descricao,
        externalReference: pedido.id,
      };
      if (parcelas > 1) {
        cobranca.installmentCount = parcelas;
        cobranca.totalValue = valorCobrado;
        delete cobranca.value;
      }

      const cob = await asaas('/payments', { method: 'POST', body: JSON.stringify(cobranca) });

      if (metodo === 'pix') {
        // O QR as vezes ainda nao esta pronto no instante seguinte a criacao da
        // cobranca (visto no sandbox: 400 na primeira chamada, 200 na segunda).
        // Uma tentativa extra resolve; se falhar de novo, o checkout ainda cobre.
        for (let tentativa = 0; tentativa < 2 && !pixPayload; tentativa++) {
          try {
            if (tentativa) await new Promise(r => setTimeout(r, 900));
            const qr = await asaas(`/payments/${cob.id}/pixQrCode`);
            pixPayload = qr?.payload || null;
            pixQr = qr?.encodedImage ? 'data:image/png;base64,' + qr.encodedImage : null;
          } catch (e) {
            console.error('pixQrCode tentativa ' + (tentativa + 1), e.message);
          }
        }
      }

      gatewayUsado = 'asaas';
      gatewayId = cob.id;
      gatewayStatus = cob.status || null;
      checkoutUrl = cob.invoiceUrl || null;
      vencimento = cob.dueDate || null;
    }

    // ---- 5. Grava no pedido -------------------------------------------------
    const patch = {
      gateway: gatewayUsado,
      gateway_id: gatewayId,
      gateway_status: gatewayStatus,
      payment_method: parcelas > 1 ? 'cartao_2x' : METODO_ORDERS[metodo],
      installments: parcelas,
      amount_charged: valorCobrado,
      surcharge_amount: acrescimo,
      pix_payload: pixPayload,
      pix_qr_image: pixQr,
      checkout_url: checkoutUrl,
    };
    await sb(`/orders?id=eq.${encodeURIComponent(pedido.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });

    return res.status(200).json({
      ok: true,
      metodo,
      parcelas,
      valor_base: valorBase,
      valor_cobrado: valorCobrado,
      acrescimo,
      valor_parcela: parcelas > 1 ? Math.ceil((valorCobrado / parcelas) * 100) / 100 : valorCobrado,
      pix_payload: pixPayload,
      pix_qr_image: pixQr,
      checkout_url: checkoutUrl,
      vencimento,
    });
  } catch (err) {
    console.error('criar-cobranca', err);
    return res.status(err.status && err.status < 500 ? 400 : 500).json({
      erro: err.message || 'Erro ao criar a cobranca.',
    });
  }
};
