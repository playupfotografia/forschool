// ============================================================================
// POST /api/criar-cobranca
//
// Cria a cobranca no Asaas (ou Woovi, no PIX) para um pedido ja existente e
// devolve ao portal o que ele precisa mostrar (copia-e-cola do PIX, QR, ou
// URL do checkout).
//
// Regra de ouro: o valor NUNCA vem do navegador. Lemos o(s) pedido(s) e as
// taxas do banco com service_role e recalculamos aqui. O que o cliente manda
// e' apenas qual(is) pedido(s), qual metodo e quantas parcelas.
//
// Body: { order_id, method: 'pix'|'credito'|'debito', installments?: 1|2 }
//
// ---- Pagamento combinado de irmaos (migration_059, Etapa 1) ---------------
// Em vez de order_id, aceita order_ids: [id1, id2] — dois pedidos de irmaos
// no MESMO projeto pagos com UMA cobranca so', com o desconto configurado em
// projects.sibling_discount_mode/value. Cada pedido continua com o PROPRIO
// numero/produtos (a ficha de cada crianca sai certa); so' a cobranca e' uma
// so'. Etapa 1 e' so' a vista (pix ou credito 1x) — parcelado fica pra depois
// de validar isto com dinheiro real, mesmo cuidado que ja foi tomado antes
// de ligar o PIX automatico e o PIX parcelado.
// Etapa 2 (24/09/2026, depois da Etapa 1 validada com PIX real): cartao
// combinado tambem parcela (Nx) — o Asaas ja' propaga o externalReference
// "grupo:<id>" pra cada parcela, e o asaas-webhook confirma o grupo inteiro.
// PIX parcelado combinado fica em criar-parcelamento-pix.js.
// ============================================================================

const { asaas, woovi, sb, usuarioDoToken, valorComTaxa, apenasDigitos, telefoneBR, emDias, dividirProporcional, calcularDescontoIrmaos, cancelarParcelasPix } = require('./_lib.js');
const crypto = require('crypto');

const BILLING = { pix: 'PIX', credito: 'CREDIT_CARD', debito: 'DEBIT_CARD' };
const METODO_ORDERS = { pix: 'pix', credito: 'cartao_1x', debito: 'cartao_debito' };

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'Use POST.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const metodo = String(body.method || '').toLowerCase();
    const linkToken = body.payment_link_token ? String(body.payment_link_token) : null;
    let parcelas = parseInt(body.installments, 10) || 1;

    // order_ids (lista) e' o caminho novo do pagamento combinado; order_id
    // (singular) continua funcionando exatamente como sempre. Por dentro,
    // trabalhamos so' com a lista — 1 item nela e' o comportamento de sempre.
    const orderIds = Array.isArray(body.order_ids) && body.order_ids.length
      ? [...new Set(body.order_ids.map(String))]
      : (body.order_id ? [String(body.order_id)] : []);
    const combinado = orderIds.length > 1;

    if (!orderIds.length) return res.status(400).json({ erro: 'order_id e obrigatorio.' });
    if (!BILLING[metodo]) return res.status(400).json({ erro: 'Metodo invalido.' });

    // Falamos com o banco por service_role, que ignora RLS — sem esta checagem
    // qualquer um que adivinhasse um id geraria cobranca pro pedido alheio.
    // Duas formas de autorizar um pedido SOLO: (1) login normal do pai
    // (fluxo do portal), ou (2) o payment_link_token do pedido (link publico
    // gerado no admin pra responsavel que nao consegue logar — migration_037).
    // Combinado exige login: o link publico e' pra 1 responsavel sem conta,
    // nao faz sentido "combinar" nada por ali.
    const uid = await usuarioDoToken(req);
    if (!uid && !linkToken) {
      return res.status(401).json({ erro: 'Sessao expirada. Faca login novamente.' });
    }
    if (combinado && !uid) {
      return res.status(401).json({ erro: 'Faca login pra pagar pedidos juntos.' });
    }

    // ---- 1. Pedido(s) + responsavel + aluno --------------------------------
    const idsSql = orderIds.map((id) => encodeURIComponent(id)).join(',');
    const pedidosBrutos = await sb(
      `/orders?id=in.(${idsSql})&select=` +
      'id,order_number,total_amount,payment_status,gateway,gateway_id,payment_group_id,has_paid_installment,student_id,project_id,' +
      'user_id,payment_link_token,users(name,email,cpf,phone),students(name)'
    );
    if (!pedidosBrutos || pedidosBrutos.length !== orderIds.length) {
      return res.status(404).json({ erro: 'Pedido nao encontrado.' });
    }
    // Mantem a ordem que o cliente mandou — o 1o e' o "pedido principal"
    // (o da tela que esta chamando isto agora), usado pros dados do
    // responsavel/cliente do gateway.
    const pedidosGrupo = orderIds.map((id) => pedidosBrutos.find((p) => p.id === id));

    for (const p of pedidosGrupo) {
      const autorizadoPorLogin = uid && (!p.user_id || p.user_id === uid);
      const autorizadoPorToken = !combinado && linkToken && p.payment_link_token && linkToken === p.payment_link_token;
      if (!autorizadoPorLogin && !autorizadoPorToken) {
        return res.status(403).json({ erro: 'Esse pedido nao e seu.' });
      }
      if (p.payment_status === 'paid') {
        return res.status(409).json({ erro: `O pedido ${p.order_number || ''} ja esta pago.`.trim() });
      }
      // PIX parcelado com parcela ja' paga: tem dinheiro dentro, trocar de
      // forma aqui cancelaria as parcelas restantes sem contar a que entrou.
      if (p.has_paid_installment) {
        return res.status(409).json({
          erro: `O pedido ${p.order_number || ''} ja tem parcela paga. Pra mudar a forma de pagamento, fale com a Play Up.`,
        });
      }
    }

    if (combinado) {
      // So' entre irmaos do MESMO projeto (ver comentario da migration_059) —
      // projetos diferentes podem ter gateway/configuracao de pagamento
      // diferente entre si.
      const projIds = new Set(pedidosGrupo.map((p) => p.project_id));
      if (projIds.size > 1 || !pedidosGrupo[0].project_id) {
        return res.status(400).json({ erro: 'So da pra pagar junto pedidos do mesmo projeto.' });
      }
    }

    const pedido = pedidosGrupo[0];   // "principal": de onde vem cliente/responsavel do gateway
    const valorBase0 = pedidosGrupo.reduce((s, p) => s + (Number(p.total_amount) || 0), 0);
    if (valorBase0 <= 0) return res.status(400).json({ erro: 'Pedido sem valor.' });

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
        `/projects?id=eq.${encodeURIComponent(pedido.project_id)}&select=max_installments,surcharge_mode,pix_mode,woovi_conta,sibling_discount_mode,sibling_discount_value`
      );
      projCfg = projs?.[0] || null;
    }
    const wooviConta = projCfg?.woovi_conta || null;

    // Desconto de irmaos (migration_059) — so' entra se for combinado e o
    // projeto tiver configurado (em branco = sem desconto, nenhum projeto
    // ganha isso sozinho). Calculado aqui no SERVIDOR: o navegador so mandou
    // QUAIS pedidos, nunca o valor.
    const descontoIrmaos = combinado ? calcularDescontoIrmaos(valorBase0, projCfg) : 0;
    const valorBase = Math.round((valorBase0 - descontoIrmaos) * 100) / 100;

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
    const alunosNomes = pedidosGrupo.map((p) => p.students?.name).filter(Boolean);
    const numerosPedidos = pedidosGrupo.map((p) => p.order_number).filter(Boolean).join('+');
    const descricao = `Pedido${combinado ? 's' : ''} ${numerosPedidos}${alunosNomes.length ? ' - ' + alunosNomes.join(' + ') : ''}`;
    let pixPayload = null, pixQr = null;

    const resp = pedido.users || {};
    const cpf = apenasDigitos(resp.cpf);
    if (!cpf) {
      return res.status(400).json({
        erro: 'O responsavel esta sem CPF no cadastro, e o gateway exige o CPF do pagador.',
      });
    }

    // Referencia da cobranca: um pedido so' usa o proprio id, como sempre foi
    // (e' o que o webhook procura direto em orders.id). Combinado usa o id do
    // GRUPO — gerado aqui, gravado em orders.payment_group_id no passo 6 —
    // pra o webhook saber que precisa confirmar TODOS os pedidos de uma vez.
    const groupId = combinado ? crypto.randomUUID() : null;
    const referencia = combinado ? `grupo:${groupId}` : pedido.id;

    // Cobrancas anteriores a cancelar antes de criar a nova — cobre tanto
    // "pedido ja tinha cobranca solo e agora vai virar combinado" quanto o
    // caso de sempre (trocar de metodo/valor). Uma por (gateway, gateway_id)
    // distinto entre os pedidos do grupo — combinado ja gravou a MESMA
    // cobranca nos dois, entao normalmente e' so' uma.
    const cobrancasAntigas = [];
    {
      const vistos = new Set();
      for (const p of pedidosGrupo) {
        const chave = p.gateway + ':' + p.gateway_id;
        if (p.gateway && p.gateway_id && !vistos.has(chave)) {
          vistos.add(chave);
          cobrancasAntigas.push({ gateway: p.gateway, gateway_id: p.gateway_id });
        }
      }
    }

    // PIX parcelado que o pai trocou por outra forma: as N cobrancas das
    // parcelas tambem sao "cobranca antiga" — sem cancelar, continuariam
    // pagaveis e o robo diario seguiria cobrando. Antes de criar a nova, igual
    // as de cima. (As linhas dos irmaos de um grupo antigo sao marcadas no
    // passo 6, junto com o resto da limpeza deles.)
    try {
      await cancelarParcelasPix(orderIds, wooviConta);
    } catch (e) {
      console.error('cancelar parcelas antigas', e.causa || e.message);
      return res.status(502).json({ erro: e.message });
    }

    let patch, checkoutUrl = null, vencimento = null;

    if (pixViaWoovi) {
      // ---- 5w. Woovi: PIX automatico -----------------------------------
      // A Woovi nao tem um "cliente" separado — os dados do responsavel vao
      // direto na cobranca. Tambem nao tem um fetch de QR a parte: o brCode
      // (copia-e-cola) e o qrCodeImage ja voltam na criacao.
      for (const c of cobrancasAntigas.filter((x) => x.gateway === 'woovi')) {
        try {
          await woovi(`/api/v1/charge/${encodeURIComponent(c.gateway_id)}`, { method: 'DELETE' }, wooviConta);
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
      const correlationID = `${referencia}-${Date.now()}`;
      const cob = await woovi('/api/v1/charge', {
        method: 'POST',
        body: JSON.stringify({
          correlationID,
          value: Math.round(valorCobrado * 100),   // a Woovi trabalha em centavos
          comment: descricao,
          customer: {
            name: resp.name || 'Responsavel',
            taxID: cpf,
            email: resp.email || undefined,
            phone: telefoneBR(resp.phone) ? '+55' + telefoneBR(resp.phone) : undefined,
          },
        }),
      }, wooviConta);

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
      for (const c of cobrancasAntigas.filter((x) => x.gateway === 'asaas')) {
        try {
          await asaas(`/payments/${c.gateway_id}`, { method: 'DELETE' });
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
        externalReference: referencia,
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

    // ---- 6. Grava no(s) pedido(s) -------------------------------------------
    // Algum pedido daqui ja' fazia parte de um pagamento combinado ANTERIOR?
    // Caso que isto cobre: o pai combinou com o irmao, depois clicou em
    // "escolher outra forma de pagamento" e escolheu pagar so' o proprio
    // pedido. A cobranca do grupo antigo ja' foi cancelada la' em cima — sem
    // isto, o irmao que ficou de fora continuaria vendo na tela um QR morto.
    // Feito so' AGORA (cobranca velha cancelada e nova criada com sucesso):
    // se o cancelamento tivesse falhado, o irmao ainda teria uma cobranca
    // pagavel e precisa continuar ligado a ela. Mesmo cuidado que
    // salvar-pedido.js tem quando o carrinho muda.
    const gruposAntigos = new Set(pedidosGrupo.map((p) => p.payment_group_id).filter(Boolean));
    for (const gid of gruposAntigos) {
      const deFora = await sb(
        `/orders?payment_group_id=eq.${encodeURIComponent(gid)}&id=not.in.(${idsSql})&select=id`
      );
      if (!deFora?.length) continue;
      // Parcelas do PIX parcelado do grupo antigo: as cobrancas ja' cairam
      // junto com as nossas (sao as mesmas), aqui so' marca as linhas dele.
      try { await cancelarParcelasPix(deFora.map((o) => o.id), wooviConta); }
      catch (e) { console.error('parcelas do irmao que saiu do grupo', e.causa || e.message); }
      await sb(`/orders?payment_group_id=eq.${encodeURIComponent(gid)}&id=not.in.(${idsSql})`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          gateway: null, gateway_id: null, gateway_status: null,
          amount_charged: null, surcharge_amount: 0, installments: 1,
          payment_method: null,
          pix_payload: null, pix_qr_image: null, checkout_url: null,
          payment_group_id: null,
        }),
      });
    }

    // Combinado: TODOS os pedidos do grupo ganham os MESMOS dados de cobranca
    // (gateway, QR, checkout) — e' isso que faz a tela de pagamento de
    // qualquer um dos dois ja funcionar sem mudar renderPaymentMethods()/
    // blocoCobranca() no portal. So' amount_charged/surcharge_amount sao
    // proprios de cada pedido, rateados pelo que cada um pesa no total (pra
    // Pedidos, no admin, continuar fazendo sentido pedido a pedido).
    patch.payment_group_id = groupId;
    const pesos = pedidosGrupo.map((p) => Number(p.total_amount) || 0);
    const cobradoPorPedido = dividirProporcional(valorCobrado, pesos);
    const acrescimoPorPedido = dividirProporcional(acrescimo, pesos);
    await Promise.all(pedidosGrupo.map((p, i) => sb(`/orders?id=eq.${encodeURIComponent(p.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ ...patch, amount_charged: cobradoPorPedido[i], surcharge_amount: acrescimoPorPedido[i] }),
    })));

    return res.status(200).json({
      ok: true,
      metodo,
      parcelas,
      order_ids: pedidosGrupo.map((p) => p.id),
      valor_base: valorBase,
      valor_base_bruto: valorBase0,
      desconto_irmaos: descontoIrmaos,
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
