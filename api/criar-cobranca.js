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

const { asaas, woovi, sb, usuarioDoToken, valorComTaxa, apenasDigitos, telefoneBR, emDias } = require('./_lib.js');

const BILLING = { pix: 'PIX', credito: 'CREDIT_CARD', debito: 'DEBIT_CARD' };
const METODO_ORDERS = { pix: 'pix', credito: 'cartao_1x', debito: 'cartao_debito' };

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'Use POST.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const orderId = body.order_id;
    const metodo = String(body.method || '').toLowerCase();
    const linkToken = body.payment_link_token ? String(body.payment_link_token) : null;
    let parcelas = parseInt(body.installments, 10) || 1;

    if (!orderId) return res.status(400).json({ erro: 'order_id e obrigatorio.' });
    if (!BILLING[metodo]) return res.status(400).json({ erro: 'Metodo invalido.' });

    // Falamos com o banco por service_role, que ignora RLS — sem esta checagem
    // qualquer um que adivinhasse um id geraria cobranca pro pedido alheio.
    // Duas formas de autorizar: (1) login normal do pai (fluxo do portal),
    // ou (2) o payment_link_token do pedido (link publico gerado no admin
    // pra responsavel que nao consegue logar — migration_037). So' uma
    // das duas precisa bater.
    const uid = await usuarioDoToken(req);
    if (!uid && !linkToken) {
      return res.status(401).json({ erro: 'Sessao expirada. Faca login novamente.' });
    }

    // ---- 1. Pedido + responsavel + aluno -----------------------------------
    const pedidos = await sb(
      `/orders?id=eq.${encodeURIComponent(orderId)}&select=` +
      'id,order_number,total_amount,payment_status,gateway,gateway_id,student_id,project_id,' +
      'user_id,payment_link_token,users(name,email,cpf,phone),students(name)'
    );
    const pedido = pedidos?.[0];
    if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado.' });

    const autorizadoPorLogin = uid && (!pedido.user_id || pedido.user_id === uid);
    const autorizadoPorToken = linkToken && pedido.payment_link_token && linkToken === pedido.payment_link_token;
    if (!autorizadoPorLogin && !autorizadoPorToken) {
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
      'min_installment_value,max_installments,pix_gateway'
    );
    const cfg = cfgs?.[0];
    if (!cfg) return res.status(500).json({ erro: 'app_settings nao configurado.' });

    // PIX automatico troca de motor (Asaas ou Woovi) por uma config global —
    // nao muda por projeto. Cartao/debito continuam SEMPRE no Asaas.
    const pixViaWoovi = metodo === 'pix' && (cfg.pix_gateway === 'woovi');

    // Parcelamento, repasse e o MODO do PIX podem ser definidos por projeto
    // (migration_054 e migration_057): em branco no projeto, vale o geral.
    // Resolvido aqui no servidor de proposito — o navegador manda so' qual
    // metodo e quantas parcelas quer, nunca a decisao.
    let projCfg = null;
    if (pedido.project_id) {
      const projs = await sb(
        `/projects?id=eq.${encodeURIComponent(pedido.project_id)}&select=max_installments,surcharge_mode,pix_mode`
      );
      projCfg = projs?.[0] || null;
    }

    // pix_mode do projeto manda MAIS que o geral quando preenchido — e' o que
    // permite forcar um projeto especifico pra automatico (ou manual) mesmo
    // que o resto da escola esteja diferente (ver portal.html, mesma cadeia).
    const pixAutoHabilitado = projCfg?.pix_mode === 'automatico'
      ? true
      : projCfg?.pix_mode === 'manual'
        ? false
        : (cfg.pay_pix_enabled !== false);

    const habilitado = {
      pix: pixAutoHabilitado,
      credito: cfg.pay_credit_enabled !== false,
      debito: cfg.pay_debit_enabled === true,
    };
    if (!habilitado[metodo]) {
      return res.status(400).json({ erro: 'Esse metodo de pagamento nao esta habilitado.' });
    }

    const repassa = (projCfg?.surcharge_mode || cfg.surcharge_mode || 'pass_on') !== 'absorb';
    const maxParc = parseInt(projCfg?.max_installments, 10) || parseInt(cfg.max_installments, 10) || 1;
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

    // ---- 4. Dados do cliente (reaproveitados pelo CPF) ----------------------
    const aluno = pedido.students?.name || '';
    const descricao = `Pedido ${pedido.order_number}${aluno ? ' - ' + aluno : ''}`;
    let pixPayload = null, pixQr = null;

    const resp = pedido.users || {};
    const cpf = apenasDigitos(resp.cpf);
    if (!cpf) {
      return res.status(400).json({
        erro: 'O responsavel esta sem CPF no cadastro, e o gateway exige o CPF do pagador.',
      });
    }

    let patch, checkoutUrl = null, vencimento = null;

    if (pixViaWoovi) {
      // ---- 5w. Woovi: PIX automatico -----------------------------------
      // A Woovi nao tem um "cliente" separado — os dados do responsavel vao
      // direto na cobranca. Tambem nao tem um fetch de QR a parte: o brCode
      // (copia-e-cola) e o qrCodeImage ja voltam na criacao.
      //
      // Cancela a cobranca anterior, se houver — mesmo cuidado do bloco do
      // Asaas: trocar de metodo/valor sem cancelar deixaria duas cobrancas
      // abertas do mesmo pedido.
      if (pedido.gateway === 'woovi' && pedido.gateway_id) {
        try {
          await woovi(`/api/v1/charge/${encodeURIComponent(pedido.gateway_id)}`, { method: 'DELETE' });
        } catch (e) {
          if (e.status !== 404) {
            console.error('cancelar cobranca anterior (woovi)', e.message);
            return res.status(502).json({
              erro: 'Nao consegui cancelar a cobranca anterior. Tente de novo em instantes.',
            });
          }
        }
      }

      // correlationID e' escolhido por nos (diferente do Asaas, que devolve
      // o id) — precisa ser novo a cada cobranca, reusar um ja cancelado
      // pode ser recusado pela Woovi.
      const correlationID = `${pedido.id}-${Date.now()}`;
      const cob = await woovi('/api/v1/charge', {
        method: 'POST',
        body: JSON.stringify({
          correlationID,
          value: Math.round(valorCobrado * 100),   // a Woovi trabalha em centavos
          comment: descricao,
          customer: {
            name: resp.name || 'Responsavel',
            taxID: { taxID: cpf, type: 'BR:CPF' },
            email: resp.email || undefined,
            phone: telefoneBR(resp.phone) ? '+55' + telefoneBR(resp.phone) : undefined,
          },
        }),
      });

      pixPayload = cob.charge?.brCode || null;
      pixQr = cob.charge?.qrCodeImage || null;
      checkoutUrl = cob.charge?.paymentLinkUrl || null;
      vencimento = cob.charge?.expiresDate || null;

      patch = {
        gateway: 'woovi',
        gateway_id: correlationID,
        gateway_status: cob.charge?.status || null,
        payment_method: METODO_ORDERS[metodo],
        installments: 1,
        amount_charged: valorCobrado,
        surcharge_amount: acrescimo,
        pix_payload: pixPayload,
        pix_qr_image: pixQr,
        checkout_url: checkoutUrl,
      };
    } else {
      // ---- 5a. Asaas: cliente + cobranca + QR, como sempre foi ----------
      let clienteId = null;
      const busca = await asaas(`/customers?cpfCnpj=${cpf}&limit=1`);
      if (busca?.data?.length) {
        clienteId = busca.data[0].id;
      } else {
        const dados = {
          name: resp.name || 'Responsavel',
          cpfCnpj: cpf,
          email: resp.email || undefined,
          mobilePhone: telefoneBR(resp.phone),
          externalReference: pedido.user_id || undefined,
          notificationDisabled: true,   // quem avisa o pai e' o portal, nao o Asaas
        };

        let novo;
        try {
          novo = await asaas('/customers', { method: 'POST', body: JSON.stringify(dados) });
        } catch (e) {
          // O Asaas recusa o cadastro INTEIRO quando nao gosta do telefone, e ai
          // o pai nao consegue pagar por um campo que nem e' necessario pra
          // cobrar. As regras deles (DDD, 9 na frente) nao da' pra reproduzir
          // aqui sem errar — entao, se reclamarem do telefone, manda sem ele.
          if (dados.mobilePhone && /celular|telefone|phone/i.test(e.message || '')) {
            console.warn('asaas recusou o telefone, criando cliente sem ele:', e.message);
            delete dados.mobilePhone;
            novo = await asaas('/customers', { method: 'POST', body: JSON.stringify(dados) });
          } else {
            throw e;
          }
        }
        clienteId = novo.id;
      }

      // Cancela a cobranca anterior, se houver — mesmo motivo do bloco da
      // Woovi acima (e' o cuidado que ja existia aqui, so' movido pra dentro
      // do branch do Asaas). 404 e' esperado: cobranca ja apagada.
      if (pedido.gateway === 'asaas' && pedido.gateway_id) {
        try {
          await asaas(`/payments/${pedido.gateway_id}`, { method: 'DELETE' });
        } catch (e) {
          if (e.status !== 404) {
            console.error('cancelar cobranca anterior', e.message);
            return res.status(502).json({
              erro: 'Nao consegui cancelar a cobranca anterior. Tente de novo em instantes.',
            });
          }
        }
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

      checkoutUrl = cob.invoiceUrl || null;
      vencimento = cob.dueDate || null;

      patch = {
        gateway: 'asaas',
        gateway_id: cob.id,
        gateway_status: cob.status || null,
        payment_method: parcelas > 1 ? 'cartao_2x' : METODO_ORDERS[metodo],
        installments: parcelas,
        amount_charged: valorCobrado,
        surcharge_amount: acrescimo,
        pix_payload: pixPayload,
        pix_qr_image: pixQr,
        checkout_url: checkoutUrl,
      };
    }

    // ---- 6. Grava no pedido --------------------------------------------------
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
