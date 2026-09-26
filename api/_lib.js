// ============================================================================
// Helpers compartilhados das funcoes serverless.
// O prefixo "_" faz a Vercel ignorar este arquivo como endpoint.
//
// Sem dependencias npm de proposito: o projeto nao tem build step, entao
// falamos com o Asaas e com o Supabase por fetch direto (Node 18+).
// ============================================================================

function env(nome) {
  const v = process.env[nome];
  if (!v) throw new Error(`Variavel de ambiente ausente na Vercel: ${nome}`);
  return v;
}

// --- Asaas -----------------------------------------------------------------
async function asaas(caminho, opts = {}) {
  const base = env('ASAAS_API_URL').replace(/\/$/, '');
  const r = await fetch(base + caminho, {
    ...opts,
    headers: {
      access_token: env('ASAAS_API_KEY'),
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const texto = await r.text();
  let corpo = null;
  try { corpo = texto ? JSON.parse(texto) : null; } catch { corpo = { raw: texto }; }
  if (!r.ok) {
    const msg = corpo?.errors?.[0]?.description || corpo?.raw || `HTTP ${r.status}`;
    const e = new Error('Asaas: ' + msg);
    e.status = r.status;
    e.corpo = corpo;
    throw e;
  }
  return corpo;
}

// --- Woovi (ex-OpenPix) — PIX automatico, alternativa ao Asaas -------------
// Mesmo formato de erro do asaas(), pra criar-cobranca.js poder tratar os
// dois gateways do mesmo jeito. Auth e' o AppID cru no header, sem "Bearer".
//
// "conta" (opcional) e' o rotulo de projects.woovi_conta (migration_058) —
// um projeto de socio pode precisar que o PIX caia numa conta Woovi
// DIFERENTE da padrao (ex: teto de faturamento do MEI). A chave de cada
// conta extra mora so' na Vercel, nunca no banco — ver comentario na
// migration. Sem "conta", usa sempre WOOVI_APPID (a de sempre).
function chaveWooviDaConta(conta) {
  return conta ? env(`WOOVI_APPID_${String(conta).toUpperCase()}`) : env('WOOVI_APPID');
}

async function woovi(caminho, opts = {}, conta) {
  const base = env('WOOVI_API_URL').replace(/\/$/, '');
  const r = await fetch(base + caminho, {
    ...opts,
    headers: {
      Authorization: chaveWooviDaConta(conta),
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const texto = await r.text();
  let corpo = null;
  try { corpo = texto ? JSON.parse(texto) : null; } catch { corpo = { raw: texto }; }
  if (!r.ok) {
    const msg = corpo?.error || corpo?.errors?.[0]?.message || corpo?.raw || `HTTP ${r.status}`;
    const e = new Error('Woovi: ' + msg);
    e.status = r.status;
    e.corpo = corpo;
    throw e;
  }
  return corpo;
}

// ---------------------------------------------------------------------------
// Assinatura do webhook da Woovi (x-webhook-signature).
//
// E' RSA-SHA256 do corpo CRU da requisicao, verificado com a chave publica
// da Woovi (a mesma pra todos os webhooks, nao e' por conta). Buscamos a
// chave em vez de deixar fixa no codigo — se a Woovi trocar, a integracao
// acompanha sozinha. Guardada em memoria do processo pra nao buscar de novo
// a cada webhook (a funcao fica "quente" entre invocacoes na Vercel).
//
// ⚠️ Precisa do corpo CRU (string), nao do objeto reparseado — reserializar
// com JSON.stringify pode nao bater byte a byte com o que a Woovi assinou.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
let _chavePublicaWooviCache = null;

async function chavePublicaWoovi() {
  if (_chavePublicaWooviCache) return _chavePublicaWooviCache;
  const base = env('WOOVI_API_URL').replace(/\/$/, '');
  const r = await fetch(base + '/api/v1/webhook/public-keys');
  if (!r.ok) throw new Error('Woovi: nao consegui buscar a chave publica (HTTP ' + r.status + ')');
  const corpo = await r.json();
  // ⚠️ A doc da Woovi mostra um formato (publicKeys, base64) que NAO bate com
  // a resposta real testada em 21/09/2026: vem "public_keys" (snake_case), e
  // "key" ja' e' o PEM puro, sem base64 — mesma licao da SumUp, documentacao
  // nao prova comportamento, so' teste de verdade prova.
  const atual = (corpo?.public_keys || []).find(k => k.is_current) || corpo?.public_keys?.[0];
  if (!atual?.key) throw new Error('Woovi: resposta da chave publica em formato inesperado');
  _chavePublicaWooviCache = atual.key;
  return _chavePublicaWooviCache;
}

async function assinaturaWooviValida(corpoCru, assinaturaBase64) {
  if (!assinaturaBase64) return false;
  const chave = await chavePublicaWoovi();
  try {
    return crypto.verify(
      'RSA-SHA256',
      Buffer.from(corpoCru, 'utf8'),
      chave,
      Buffer.from(assinaturaBase64, 'base64')
    );
  } catch (e) {
    console.error('assinaturaWooviValida:', e.message);
    return false;
  }
}

// --- Supabase (REST, com service_role — ignora RLS de proposito) -----------
async function sb(caminho, opts = {}) {
  const base = env('SUPABASE_URL').replace(/\/$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const r = await fetch(base + '/rest/v1' + caminho, {
    ...opts,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const texto = await r.text();
  let corpo = null;
  try { corpo = texto ? JSON.parse(texto) : null; } catch { corpo = texto; }
  if (!r.ok) {
    const e = new Error('Supabase: ' + (corpo?.message || `HTTP ${r.status}`));
    e.status = r.status;
    throw e;
  }
  return corpo;
}

// ---------------------------------------------------------------------------
// Quem esta chamando?
// As funcoes falam com o banco usando service_role, que ignora RLS. Sem isso
// aqui, qualquer um que adivinhasse o id de um pedido poderia gerar cobranca
// ou cancelar o pedido de outra pessoa. Devolve o id do usuario logado, ou
// null se o token nao valer.
// ---------------------------------------------------------------------------
async function usuarioDoToken(req) {
  const bruto = req.headers?.authorization || '';
  const token = bruto.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const base = env('SUPABASE_URL').replace(/\/$/, '');
    const r = await fetch(base + '/auth/v1/user', {
      headers: {
        apikey: env('SUPABASE_SERVICE_ROLE_KEY'),
        Authorization: 'Bearer ' + token,
      },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Acrescimo do cartao (gross-up).
// A taxa incide sobre o valor JA acrescido, entao somar a taxa por cima
// deixaria a empresa recebendo a menos. Embutindo:
//   cobrado = (valor + taxa_fixa) / (1 - taxa% / 100)
// Arredonda pra cima no centavo pra nunca receber menos que o preco de tabela.
// Precisa bater com valorComTaxa() do admin.html.
// ---------------------------------------------------------------------------
function valorComTaxa(valor, pct, fixa) {
  const p = (Number(pct) || 0) / 100;
  const f = Number(fixa) || 0;
  const v = Number(valor) || 0;
  if (p >= 1) return v;
  return Math.ceil(((v + f) / (1 - p)) * 100) / 100;
}

function apenasDigitos(s) {
  return String(s || '').replace(/\D/g, '');
}

// ---------------------------------------------------------------------------
// Divide um valor total entre pesos, proporcionalmente — usado pra ratear o
// liquido/tarifa de uma cobranca combinada (irmaos pagando junto,
// migration_059) entre os pedidos que ela cobre. Cada pedido continua com o
// SEU numero de liquido/tarifa, coerente com o que ele custou de verdade.
//
// Arredonda cada parte pro centavo e joga a sobra (do arredondamento) na
// ULTIMA parte, pra soma bater exatamente com o valorTotal — nunca "some 1
// centavo do nada" na conferencia de caixa. Com um peso so' (pedido normal,
// nao combinado), devolve o valorTotal inteiro, sem novidade nenhuma.
// ---------------------------------------------------------------------------
function dividirProporcional(valorTotal, pesos) {
  const total = Number(valorTotal) || 0;
  if (pesos.length <= 1) return [Math.round(total * 100) / 100];
  const somaPesos = pesos.reduce((s, w) => s + (Number(w) || 0), 0) || 1;
  const partes = pesos.map((w) => Math.round((total * (Number(w) || 0) / somaPesos) * 100) / 100);
  const sobra = Math.round((total - partes.reduce((s, v) => s + v, 0)) * 100) / 100;
  partes[partes.length - 1] = Math.round((partes[partes.length - 1] + sobra) * 100) / 100;
  return partes;
}

// ---------------------------------------------------------------------------
// Desconto de irmaos (migration_059) sobre a soma dos pedidos do grupo.
// Um lugar so' pra conta, usado por criar-cobranca.js e
// criar-parcelamento-pix.js — o portal repete a MESMA regra so' pra mostrar
// (ofertarPagamentoConjunto). Nunca deixa o total abaixo de R$ 0,01.
// ---------------------------------------------------------------------------
function calcularDescontoIrmaos(valorBase0, projCfg) {
  if (!projCfg?.sibling_discount_mode) return 0;
  const v = Number(projCfg.sibling_discount_value) || 0;
  let d = projCfg.sibling_discount_mode === 'percent'
    ? Math.round(valorBase0 * v / 100 * 100) / 100
    : v;
  return Math.max(0, Math.min(d, Math.round((valorBase0 - 0.01) * 100) / 100));
}

// ---------------------------------------------------------------------------
// Acrescimo de parcelamento por produto (migration_061). Produto principal,
// produto de irmaos etc podem custar mais caro parcelado que a vista (ex:
// R$170 a vista / 3x R$60=R$180) — incentivo pra pagar a vista, configurado
// em school_prices.pix_parcela_acrescimo, POR PROJETO.
//
// Soma UMA VEZ por produto distinto presente no(s) pedido(s) — nunca
// multiplica pela quantidade nem pelo numero de pedidos do grupo (regra dada
// pelo Daniel: irmao parcelado e' sempre +R$12 fixo, 2 ou mais nao muda).
// ---------------------------------------------------------------------------
async function calcularAcrescimoParcelamento(orderIds, projectId) {
  if (!projectId || !orderIds?.length) return 0;
  const idsSql = orderIds.map((id) => encodeURIComponent(id)).join(',');
  const itens = await sb(`/order_items?order_id=in.(${idsSql})&select=product_id`);
  const produtoIds = [...new Set((itens || []).map((i) => i.product_id).filter(Boolean))];
  if (!produtoIds.length) return 0;
  const precos = await sb(
    `/school_prices?project_id=eq.${encodeURIComponent(projectId)}&product_id=in.(${produtoIds.map((id) => encodeURIComponent(id)).join(',')})&select=product_id,pix_parcela_acrescimo`
  );
  return (precos || []).reduce((s, p) => s + (Number(p.pix_parcela_acrescimo) || 0), 0);
}

// ---------------------------------------------------------------------------
// Cancela as parcelas do PIX parcelado (migration_058) ainda em aberto destes
// pedidos: derruba a cobranca na Woovi e marca a linha 'cancelada' (nunca
// apaga — fica o historico). Sem isso, trocar de forma de pagamento, editar o
// carrinho ou cancelar o pedido deixava as N cobrancas vivas, e o robo diario
// continuava mandando lembrete e gerando 2a tentativa de um pedido que ja nao
// e' mais parcelado.
//
// Pagamento combinado de irmaos: a MESMA cobranca (gateway_id) aparece numa
// linha de cada pedido — por isso o DELETE na Woovi e' por gateway_id
// distinto, e o 404 da segunda vez e' esperado.
// Falha de verdade (nao 404) lanca erro: melhor o chamador parar e pedir pra
// tentar de novo do que seguir com cobranca antiga ainda pagavel.
// ---------------------------------------------------------------------------
async function cancelarParcelasPix(orderIds, wooviConta) {
  const ids = [...new Set((orderIds || []).filter(Boolean))];
  if (!ids.length) return 0;
  const lista = ids.map((id) => encodeURIComponent(id)).join(',');
  const abertas = await sb(
    `/pix_installments?order_id=in.(${lista})&status=in.(scheduled,active)&select=id,gateway_id`
  );
  if (!abertas?.length) return 0;

  const cobrancas = [...new Set(abertas.map((p) => p.gateway_id).filter(Boolean))];
  for (const gid of cobrancas) {
    try {
      await woovi(`/api/v1/charge/${encodeURIComponent(gid)}`, { method: 'DELETE' }, wooviConta);
    } catch (e) {
      if (e.status !== 404) {
        const erro = new Error('Nao consegui cancelar as parcelas do PIX. Tente de novo em instantes.');
        erro.status = 502;
        erro.causa = e.message;
        throw erro;
      }
    }
  }
  await sb(`/pix_installments?id=in.(${abertas.map((p) => encodeURIComponent(p.id)).join(',')})`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'cancelada' }),
  });
  return abertas.length;
}

// ---------------------------------------------------------------------------
// Telefone pro Asaas, ou nada.
//
// O Asaas recusa o cadastro inteiro do cliente quando o telefone nao e'
// valido ("O celular informado e invalido") — e o pai fica sem conseguir
// pagar por causa de um campo que nem e' obrigatorio pra cobranca. Entao so'
// mandamos se parecer numero brasileiro de verdade; qualquer coisa estranha
// vira undefined e a cobranca segue.
// ---------------------------------------------------------------------------
function telefoneBR(valor) {
  let d = apenasDigitos(valor);
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);   // veio com +55
  return (d.length === 10 || d.length === 11) ? d : undefined;
}

// Data no formato YYYY-MM-DD, N dias a partir de hoje
function emDias(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// QUANTO ENTROU, E QUANDO CAI — usado pelo webhook e pelo resync.
//
// Duas armadilhas do Asaas moram aqui:
//
// 1. Pedido parcelado vira UMA cobranca POR PARCELA, cada uma com seu webhook
//    e seu netValue. Gravar o netValue que chegou por ultimo dava o liquido de
//    UMA parcela: pedido de R$ 149,66 aparecia com R$ 72,73 "na conta" e uma
//    tarifa inventada de R$ 76,93 (bug real, achado nos dados de setembro de
//    2026). Por isso, havendo parcelamento, pedimos TODAS as parcelas e
//    somamos. Somar a partir da LISTA — em vez de acumular a cada webhook — e'
//    o que torna isto idempotente: o Asaas reenvia evento quando respondemos
//    erro, e reenvio nao pode dobrar valor.
//
// 2. Com a antecipacao automatica ligada (esta conta, desde 03/09/2026), o
//    dinheiro entra por FORA da cobranca: ela continua CONFIRMED com data de
//    credito la' na frente (D+32, D+64) enquanto o valor ja' caiu em ~2 dias
//    uteis. Olhar so' a cobranca diria "aguardando" pra dinheiro que ja' esta
//    na conta — por isso consultamos tambem as antecipacoes.
// ---------------------------------------------------------------------------
const RECEBIDO = new Set(['RECEIVED', 'RECEIVED_IN_CASH']);
const PAGO_OU_RECEBIDO = new Set(['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH']);
const ANTECIPACAO_CREDITADA = new Set(['CREDITED', 'DEBITED']);

async function resumoFinanceiro(pag) {
  let parcelas = [pag];
  if (pag.installment) {
    const r = await asaas(`/payments?installment=${encodeURIComponent(pag.installment)}&limit=100`);
    if (!r?.data?.length) throw new Error('parcelamento sem parcelas na resposta do Asaas');
    parcelas = r.data;
  }

  // --- Antecipacao, parcela por parcela ------------------------------------
  // Confirmado na pratica em 15/09/2026, com o P0090:
  //   /anticipations?installment=<id>  -> 0 resultados
  //   /anticipations?payment=<id>      -> 1 resultado   <- este e' o caminho
  // Entao perguntamos POR PARCELA. Sao poucas (1 ou 2), nao pesa.
  const antecipacaoDe = {};
  const tentativas = [];
  await Promise.all(parcelas.map(async (p) => {
    try {
      const r = await asaas(`/anticipations?payment=${encodeURIComponent(p.id)}&limit=10`);
      const lista = r?.data || [];
      tentativas.push({ parcela: p.id, qtd: lista.length });
      antecipacaoDe[p.id] =
        lista.find(a => ANTECIPACAO_CREDITADA.has(String(a.status || '').toUpperCase())) || null;
    } catch (e) {
      tentativas.push({ parcela: p.id, erro: e.message });
      antecipacaoDe[p.id] = null;
    }
  }));

  // --- Quanto cai por parcela ----------------------------------------------
  // A ordem importa, e foi aprendida na marra:
  //   1. Antecipacao CREDITED -> o netValue DELA e' o valor final. Ja' esta'
  //      sem a tarifa do cartao E sem a taxa da antecipacao. No P0090:
  //      totalValue 74,83 -> value 72,73 (menos cartao) -> netValue 71,49.
  //   2. Sem antecipacao, mas cobranca RECEIVED -> o netValue da cobranca vale,
  //      porque nessa altura o Asaas ja' calculou.
  //   3. Cobranca so' CONFIRMED e sem antecipacao -> NAO SE SABE. O netValue
  //      vem igual ao value (sem tarifa nenhuma descontada), e usa-lo seria
  //      dizer que o Asaas trabalha de graca.
  const liquidoDe = (p) => {
    const a = antecipacaoDe[p.id];
    if (a && Number(a.netValue) > 0) return Number(a.netValue);
    if (RECEBIDO.has(p.status) && Number(p.netValue) > 0) return Number(p.netValue);
    return null;
  };

  const pagas = parcelas.filter(p => PAGO_OU_RECEBIDO.has(p.status));
  const valores = pagas.map(liquidoDe);
  // Uma parcela sem valor confiavel invalida a soma inteira: meio liquido e'
  // pior que nenhum, porque parece um numero completo.
  const liquido = valores.some(v => v === null) ? 0 : valores.reduce((s, v) => s + v, 0);

  // Previsao do pedido INTEIRO = a ultima parcela a cair.
  // ⚠️ E' a data da liquidacao NORMAL, SEM antecipacao. Nao mostre como
  // "quando cai" sem antes olhar a antecipacao (ver ponto 2 acima).
  const previstas = parcelas
    .map(p => p.estimatedCreditDate || p.creditDate)
    .filter(Boolean).sort();

  // ⚠️ creditDate ja' vem preenchido em CONFIRMED, com a data PROGRAMADA —
  // entao ele nao prova que caiu. Quem prova e' o status.
  const todasCairam = parcelas.length > 0 && parcelas.every(p => RECEBIDO.has(p.status));
  let caiuEm = todasCairam
    ? (parcelas.map(p => p.creditDate || p.paymentDate).filter(Boolean).sort().pop() || null)
    : null;

  // Com a antecipacao, o dinheiro entra ANTES e por fora da cobranca — que
  // segue CONFIRMED com data la' na frente. So' conta como "caiu" se TODAS as
  // parcelas foram antecipadas e creditadas: metade antecipada e' dinheiro
  // pela metade.
  //
  // A antecipacao nao traz um campo de "creditado em"; anticipationDate e' o
  // mais proximo disso (no P0090 veio igual ao dia da confirmacao). O Asaas
  // promete o credito em ate' 2 dias uteis, entao a data pode sair um ou dois
  // dias antes do extrato — e' referencia, nao carimbo do banco.
  const antecipacoes = parcelas.map(p => antecipacaoDe[p.id]).filter(Boolean);
  let antecipadoEm = null;
  if (!caiuEm && antecipacoes.length >= parcelas.length && parcelas.length > 0) {
    antecipadoEm = antecipacoes
      .map(a => a.anticipationDate || a.requestDate)
      .filter(Boolean).sort().pop() || null;
    caiuEm = antecipadoEm;
  }

  // ⚠️ O liquido so' e' gravado se for CRIVEL — ver liquidoCrivel abaixo.
  const liq = Math.round(liquido * 100) / 100;

  return {
    liquido: liq,
    previsto: previstas.length ? previstas[previstas.length - 1] : null,
    caiuEm,
    antecipadoEm,
    parcelas: parcelas.length,
    parcelasPagas: pagas.length,
    // So' pra diagnostico (o resync mostra ao admin). O webhook ignora.
    statusParcelas: parcelas.map(p => p.status),
    antecipacoes,
    tentativasAntecipacao: tentativas,
    parcelasBrutas: parcelas.map(p => ({
      id: p.id, status: p.status, value: p.value, netValue: p.netValue,
      estimatedCreditDate: p.estimatedCreditDate, creditDate: p.creditDate,
      confirmedDate: p.confirmedDate, paymentDate: p.paymentDate,
    })),
  };
}

// O liquido faz sentido? Tem que ser positivo e MENOR que o cobrado — cartao
// sem tarifa nao existe. Fora disso, nao gravamos nada (ver comentario acima).
function liquidoCrivel(liquido, cobrado) {
  return liquido > 0 && cobrado > 0 && liquido < cobrado;
}

// ---------------------------------------------------------------------------
// Aviso de venda (e-mail e/ou Telegram).
//
// Os dois canais sao opcionais e independentes: cada um so' dispara se as
// variaveis dele existirem na Vercel. Da' pra comecar com um e somar o outro
// depois, sem mexer em codigo.
//   E-mail   -> RESEND_API_KEY, ALERTA_EMAIL  (opcional: ALERTA_EMAIL_FROM)
//   Telegram -> TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//
// NUNCA derruba o webhook: avisar e' secundario, confirmar o pedido e' o que
// importa. Toda falha aqui vira log, nao erro.
// ---------------------------------------------------------------------------
function moeda(v) {
  return 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
}

const METODO_LABEL = {
  pix: 'PIX',
  cartao_1x: 'Cartão de crédito',
  cartao_2x: 'Cartão de crédito 2x',
  cartao_debito: 'Cartão de débito',
  dinheiro: 'Dinheiro',
  outro: 'Outro',
};

function linhasDaVenda(pedido) {
  const l = [
    ['Pedido', pedido.order_number || '—'],
    ['Aluno', pedido.student?.name || '—'],
    ['Escola', pedido.school?.name || '—'],
    ['Responsável', pedido.user?.name || '—'],
    ['Pagamento', METODO_LABEL[pedido.payment_method] || pedido.payment_method || '—'],
    ['Valor pago', moeda(pedido.amount_charged ?? pedido.total_amount)],
  ];
  if (pedido.net_amount != null) {
    l.push(['Tarifa do Asaas', moeda(pedido.gateway_fee ?? 0)]);
    l.push(['Caiu na conta', moeda(pedido.net_amount)]);
  }
  if (pedido.user?.phone) l.push(['WhatsApp do responsável', pedido.user.phone]);
  return l;
}

async function avisarTelegram(pedido) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { canal: 'telegram', enviado: false, motivo: 'nao configurado' };

  const corpo = linhasDaVenda(pedido).map(([k, v]) => `<b>${k}:</b> ${v}`).join('\n');
  const texto = `💰 <b>Venda confirmada</b>\n\n${corpo}`;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: texto, parse_mode: 'HTML' }),
  });
  if (!r.ok) throw new Error('Telegram HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return { canal: 'telegram', enviado: true };
}

async function avisarEmail(pedido) {
  const key = process.env.RESEND_API_KEY;
  const para = process.env.ALERTA_EMAIL;
  if (!key || !para) return { canal: 'email', enviado: false, motivo: 'nao configurado' };

  const de = process.env.ALERTA_EMAIL_FROM || 'For School <onboarding@resend.dev>';
  const linhas = linhasDaVenda(pedido)
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#666">${k}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`)
    .join('');
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">
    <h2 style="color:#27AE60;margin:0 0 4px">💰 Venda confirmada</h2>
    <p style="color:#666;margin:0 0 16px;font-size:14px">O pagamento caiu e o pedido já está marcado como pago.</p>
    <table style="border-collapse:collapse;font-size:14px">${linhas}</table>
  </div>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: de,
      to: para.split(',').map((e) => e.trim()).filter(Boolean),
      // A escola vai no assunto de proposito: e' o que permite criar um filtro
      // por colegio no Gmail sem precisar de um endereco diferente pra cada um.
      subject: [
        '💰 Venda',
        pedido.school?.name,
        moeda(pedido.amount_charged ?? pedido.total_amount),
        pedido.order_number ? `(${pedido.order_number})` : null,
      ].filter(Boolean).join(' — '),
      html,
    }),
  });
  if (!r.ok) throw new Error('Resend HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return { canal: 'email', enviado: true };
}

async function avisarVenda(pedido) {
  const res = await Promise.allSettled([avisarTelegram(pedido), avisarEmail(pedido)]);
  res.forEach((r) => {
    if (r.status === 'rejected') console.error('aviso de venda falhou:', r.reason?.message || r.reason);
    else if (!r.value.enviado) console.log(`aviso ${r.value.canal}: ${r.value.motivo}`);
  });
}

// ---------------------------------------------------------------------------
// Aviso de PAGAMENTO DESFEITO — o oposto do aviso de venda.
//
// Caso real que motivou isto (15/09/2026): o cartao e' confirmado na hora,
// mas o banco do cliente ainda pode pedir autorizacao a ele, e a analise de
// risco do Asaas ainda pode reprovar depois. Quando isso acontece o pedido
// volta pra pendente — e ate' agora voltava CALADO. O Daniel so' descobriria
// conferindo extrato, dias depois, com o aluno ja' fotografado.
//
// Vai pelos dois canais (e-mail e Telegram), porque este e' mais urgente que
// o de venda: e' dinheiro que sumiu, nao que entrou.
// ---------------------------------------------------------------------------
const MOTIVO_DESFEITO = {
  PAYMENT_REPROVED_BY_RISK_ANALYSIS: 'Reprovado na análise de risco do Asaas',
  PAYMENT_CREDIT_CARD_CAPTURE_REFUSED: 'O banco recusou a captura do cartão',
  PAYMENT_CHARGEBACK_REQUESTED: 'Chargeback solicitado pelo titular do cartão',
  PAYMENT_CHARGEBACK_DISPUTE: 'Chargeback em disputa',
  PAYMENT_REFUNDED: 'Pagamento estornado',
  PAYMENT_REVERSED: 'Pagamento revertido',
  PAYMENT_DELETED: 'Cobrança apagada no Asaas',
};

function linhasDoDesfeito(pedido, evento) {
  const l = [
    ['Motivo', MOTIVO_DESFEITO[evento] || evento || '—'],
    ['Pedido', pedido.order_number || '—'],
    ['Aluno', pedido.student?.name || '—'],
    ['Escola', pedido.school?.name || '—'],
    ['Responsável', pedido.user?.name || '—'],
    ['Pagamento', METODO_LABEL[pedido.payment_method] || pedido.payment_method || '—'],
    ['Valor', moeda(pedido.amount_charged ?? pedido.total_amount)],
    ['Situação agora', pedido.payment_status === 'refunded' ? 'Estornado' : 'Voltou para pendente'],
  ];
  if (pedido.user?.phone) l.push(['WhatsApp do responsável', pedido.user.phone]);
  return l;
}

async function avisarDesfeitoTelegram(pedido, evento) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { canal: 'telegram', enviado: false, motivo: 'nao configurado' };

  const corpo = linhasDoDesfeito(pedido, evento).map(([k, v]) => `<b>${k}:</b> ${v}`).join('\n');
  const texto = `⚠️ <b>Pagamento desfeito</b>\n\n${corpo}`;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: texto, parse_mode: 'HTML' }),
  });
  if (!r.ok) throw new Error('Telegram HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return { canal: 'telegram', enviado: true };
}

async function avisarDesfeitoEmail(pedido, evento) {
  const key = process.env.RESEND_API_KEY;
  const para = process.env.ALERTA_EMAIL;
  if (!key || !para) return { canal: 'email', enviado: false, motivo: 'nao configurado' };

  const de = process.env.ALERTA_EMAIL_FROM || 'For School <onboarding@resend.dev>';
  const linhas = linhasDoDesfeito(pedido, evento)
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#666">${k}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`)
    .join('');
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">
    <h2 style="color:#E74C3C;margin:0 0 4px">⚠️ Pagamento desfeito</h2>
    <p style="color:#666;margin:0 0 16px;font-size:14px">
      Um pedido que estava pago deixou de estar. Confira no painel do Asaas e
      fale com o responsável antes de entregar as fotos.
    </p>
    <table style="border-collapse:collapse;font-size:14px">${linhas}</table>
  </div>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: de,
      to: para.split(',').map((e) => e.trim()).filter(Boolean),
      subject: [
        '⚠️ Pagamento desfeito',
        pedido.school?.name,
        moeda(pedido.amount_charged ?? pedido.total_amount),
        pedido.order_number ? `(${pedido.order_number})` : null,
      ].filter(Boolean).join(' — '),
      html,
    }),
  });
  if (!r.ok) throw new Error('Resend HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return { canal: 'email', enviado: true };
}

async function avisarPagamentoDesfeito(pedido, evento) {
  const res = await Promise.allSettled([
    avisarDesfeitoTelegram(pedido, evento),
    avisarDesfeitoEmail(pedido, evento),
  ]);
  res.forEach((r) => {
    if (r.status === 'rejected') console.error('aviso de pagamento desfeito falhou:', r.reason?.message || r.reason);
    else if (!r.value.enviado) console.log(`aviso ${r.value.canal}: ${r.value.motivo}`);
  });
}

// ---------------------------------------------------------------------------
// Aviso de pedido novo, ainda pendente (so' e-mail por enquanto).
//
// Existe pra cobrir o PIX manual: diferente do cartao pelo Asaas, o PIX
// manual nao passa por nenhum webhook — o pai so' ve uma chave fixa e paga
// fora do sistema. Sem isso, nenhum evento avisa que um pedido chegou.
// Disparado na criacao do pedido (antes de saber qual metodo o pai vai
// escolher), entao tambem dispara pra pedido que acaba sendo pago no cartao
// automatico — esse ainda ganha o aviso de "venda confirmada" de sempre
// quando o webhook confirmar, os dois nao se excluem.
// ---------------------------------------------------------------------------
function linhasDoPedidoPendente(pedido) {
  const l = [
    ['Pedido', pedido.order_number || '—'],
    ['Aluno', pedido.student?.name || '—'],
    ['Escola', pedido.school?.name || '—'],
    ['Responsável', pedido.user?.name || '—'],
    ['Valor do pedido', moeda(pedido.total_amount)],
  ];
  if (pedido.user?.phone) l.push(['WhatsApp do responsável', pedido.user.phone]);
  return l;
}

async function avisarEmailPedidoPendente(pedido) {
  const key = process.env.RESEND_API_KEY;
  const para = process.env.ALERTA_EMAIL;
  if (!key || !para) return { canal: 'email', enviado: false, motivo: 'nao configurado' };

  const de = process.env.ALERTA_EMAIL_FROM || 'For School <onboarding@resend.dev>';
  const linhas = linhasDoPedidoPendente(pedido)
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#666">${k}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`)
    .join('');
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">
    <h2 style="color:#4B6BFB;margin:0 0 4px">🛒 Novo pedido</h2>
    <p style="color:#666;margin:0 0 16px;font-size:14px">
      Aguardando pagamento. Se for PIX manual, confira o extrato — esse
      método não avisa sozinho. Se for cartão pelo Asaas, você recebe o
      aviso de venda confirmada quando cair.
    </p>
    <table style="border-collapse:collapse;font-size:14px">${linhas}</table>
  </div>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: de,
      to: para.split(',').map((e) => e.trim()).filter(Boolean),
      subject: [
        '🛒 Novo pedido',
        pedido.school?.name,
        moeda(pedido.total_amount),
        pedido.order_number ? `(${pedido.order_number})` : null,
      ].filter(Boolean).join(' — '),
      html,
    }),
  });
  if (!r.ok) throw new Error('Resend HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return { canal: 'email', enviado: true };
}

async function avisarPedidoPendente(pedido) {
  const res = await Promise.allSettled([avisarEmailPedidoPendente(pedido)]);
  res.forEach((r) => {
    if (r.status === 'rejected') console.error('aviso de pedido pendente falhou:', r.reason?.message || r.reason);
    else if (!r.value.enviado) console.log(`aviso ${r.value.canal}: ${r.value.motivo}`);
  });
}

// ---------------------------------------------------------------------------
// Aviso de pedido CANCELADO PELO RESPONSÁVEL (migration_060) — pra saber
// quem desistiu e poder chamar no WhatsApp, se fizer sentido. Cancelamento
// feito pelo admin não avisa (quem cancelou já sabe).
// ---------------------------------------------------------------------------
async function avisarEmailPedidoCancelado(pedido) {
  const key = process.env.RESEND_API_KEY;
  const para = process.env.ALERTA_EMAIL;
  if (!key || !para) return { canal: 'email', enviado: false, motivo: 'nao configurado' };

  const de = process.env.ALERTA_EMAIL_FROM || 'For School <onboarding@resend.dev>';
  const linhas = linhasDoPedidoPendente(pedido)
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#666">${k}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`)
    .join('');
  const tel = String(pedido.user?.phone || '').replace(/\D/g, '');
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">
    <h2 style="color:#E3815A;margin:0 0 4px">✕ Pedido cancelado pelo responsável</h2>
    <p style="color:#666;margin:0 0 16px;font-size:14px">
      O responsável desistiu deste pedido pela Minha Área. A cobrança em aberto
      foi cancelada junto. O pedido continua no admin, marcado como cancelado.
    </p>
    <table style="border-collapse:collapse;font-size:14px">${linhas}</table>
    ${tel ? `<p style="margin:16px 0 0"><a href="https://wa.me/55${tel}" style="color:#27AE60;font-weight:600">💬 Chamar no WhatsApp</a></p>` : ''}
  </div>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: de,
      to: para.split(',').map((e) => e.trim()).filter(Boolean),
      subject: [
        '✕ Pedido cancelado',
        pedido.school?.name,
        moeda(pedido.total_amount),
        pedido.order_number ? `(${pedido.order_number})` : null,
      ].filter(Boolean).join(' — '),
      html,
    }),
  });
  if (!r.ok) throw new Error('Resend HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return { canal: 'email', enviado: true };
}

async function avisarPedidoCancelado(pedido) {
  const res = await Promise.allSettled([avisarEmailPedidoCancelado(pedido)]);
  res.forEach((r) => {
    if (r.status === 'rejected') console.error('aviso de pedido cancelado falhou:', r.reason?.message || r.reason);
    else if (!r.value.enviado) console.log(`aviso ${r.value.canal}: ${r.value.motivo}`);
  });
}

// ---------------------------------------------------------------------------
// Aviso de PARCELA paga (PIX parcelado, migration_058) — mais leve que
// avisarVenda: uma parcela paga nao e' a venda inteira confirmada, so' um
// passo dela. A venda so' conta como confirmada quando a ULTIMA parcela cai
// (quem chama decide isso, comparando com o total de parcelas restantes).
// ---------------------------------------------------------------------------
async function avisarEmailParcelaPaga(pedido, parcela) {
  const key = process.env.RESEND_API_KEY;
  const para = process.env.ALERTA_EMAIL;
  if (!key || !para) return { canal: 'email', enviado: false, motivo: 'nao configurado' };

  const de = process.env.ALERTA_EMAIL_FROM || 'For School <onboarding@resend.dev>';
  const linhas = [
    ['Pedido', pedido.order_number || '—'],
    ['Parcela', `${parcela.installment_number} de ${parcela.total_installments}`],
    ['Aluno', pedido.student?.name || '—'],
    ['Escola', pedido.school?.name || '—'],
    ['Responsável', pedido.user?.name || '—'],
    ['Valor da parcela', moeda(parcela.value)],
  ].map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#666">${k}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`)
   .join('');
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">
    <h2 style="color:#27AE60;margin:0 0 4px">💰 Parcela paga</h2>
    <p style="color:#666;margin:0 0 16px;font-size:14px">Faltam ${parcela.total_installments - parcela.installment_number} parcela(s) pra esse pedido fechar.</p>
    <table style="border-collapse:collapse;font-size:14px">${linhas}</table>
  </div>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: de,
      to: para.split(',').map((e) => e.trim()).filter(Boolean),
      subject: [
        `💰 Parcela ${parcela.installment_number}/${parcela.total_installments}`,
        pedido.school?.name,
        moeda(parcela.value),
        pedido.order_number ? `(${pedido.order_number})` : null,
      ].filter(Boolean).join(' — '),
      html,
    }),
  });
  if (!r.ok) throw new Error('Resend HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return { canal: 'email', enviado: true };
}

async function avisarParcelaPaga(pedido, parcela) {
  const res = await Promise.allSettled([avisarEmailParcelaPaga(pedido, parcela)]);
  res.forEach((r) => {
    if (r.status === 'rejected') console.error('aviso de parcela paga falhou:', r.reason?.message || r.reason);
    else if (!r.value.enviado) console.log(`aviso ${r.value.canal}: ${r.value.motivo}`);
  });
}

// ---------------------------------------------------------------------------
// Lembrete de parcela perto do vencimento (chamado pelo robo diario,
// api/cron-parcelas-atrasadas.js) — so' informativo, o pai ja' recebeu o
// mesmo QR na hora da compra.
// ---------------------------------------------------------------------------
async function avisarEmailLembreteParcela(pedido, parcela) {
  const key = process.env.RESEND_API_KEY;
  const para = process.env.ALERTA_EMAIL;
  if (!key || !para) return { canal: 'email', enviado: false, motivo: 'nao configurado' };

  const de = process.env.ALERTA_EMAIL_FROM || 'For School <onboarding@resend.dev>';
  const linhas = [
    ['Pedido', pedido.order_number || '—'],
    ['Parcela', `${parcela.installment_number} de ${parcela.total_installments}`],
    ['Aluno', pedido.student?.name || '—'],
    ['Escola', pedido.school?.name || '—'],
    ['Responsável', pedido.user?.name || '—'],
    ['Valor', moeda(parcela.value)],
    ['Vencimento', parcela.due_date],
  ].map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#666">${k}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`)
   .join('');
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">
    <h2 style="color:#E3815A;margin:0 0 4px">⏰ Parcela vence em breve</h2>
    <p style="color:#666;margin:0 0 16px;font-size:14px">Aviso informativo — o pai já recebeu o mesmo QR na hora da compra.</p>
    <table style="border-collapse:collapse;font-size:14px">${linhas}</table>
  </div>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: de,
      to: para.split(',').map((e) => e.trim()).filter(Boolean),
      subject: [
        `⏰ Parcela ${parcela.installment_number}/${parcela.total_installments} vence em breve`,
        pedido.school?.name,
        pedido.order_number ? `(${pedido.order_number})` : null,
      ].filter(Boolean).join(' — '),
      html,
    }),
  });
  if (!r.ok) throw new Error('Resend HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return { canal: 'email', enviado: true };
}

async function avisarLembreteParcela(pedido, parcela) {
  const res = await Promise.allSettled([avisarEmailLembreteParcela(pedido, parcela)]);
  res.forEach((r) => {
    if (r.status === 'rejected') console.error('lembrete de parcela falhou:', r.reason?.message || r.reason);
    else if (!r.value.enviado) console.log(`lembrete ${r.value.canal}: ${r.value.motivo}`);
  });
}

// ---------------------------------------------------------------------------
// Parcela ficou ATRASADA — a 2a tentativa automatica tambem venceu sem
// pagar. Daqui pra frente e' acompanhamento manual (WhatsApp), mesmo padrao
// do PIX manual comum — mas sem esse aviso ninguem saberia que aconteceu a
// nao ser consultando pix_installments direto no Supabase.
// ---------------------------------------------------------------------------
async function avisarEmailParcelaAtrasada(pedido, parcela) {
  const key = process.env.RESEND_API_KEY;
  const para = process.env.ALERTA_EMAIL;
  if (!key || !para) return { canal: 'email', enviado: false, motivo: 'nao configurado' };

  const de = process.env.ALERTA_EMAIL_FROM || 'For School <onboarding@resend.dev>';
  const linhas = [
    ['Pedido', pedido.order_number || '—'],
    ['Parcela', `${parcela.installment_number} de ${parcela.total_installments}`],
    ['Aluno', pedido.student?.name || '—'],
    ['Escola', pedido.school?.name || '—'],
    ['Responsável', pedido.user?.name || '—'],
    ['Valor', moeda(parcela.value)],
  ].map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#666">${k}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`)
   .join('');
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">
    <h2 style="color:#E74C3C;margin:0 0 4px">🔴 Parcela atrasada</h2>
    <p style="color:#666;margin:0 0 16px;font-size:14px">
      Duas tentativas automáticas sem pagar. A partir daqui é acompanhamento
      manual — chame o responsável por WhatsApp.
    </p>
    <table style="border-collapse:collapse;font-size:14px">${linhas}</table>
    ${pedido.user?.phone ? `<p style="margin:16px 0 0"><a href="https://wa.me/55${pedido.user.phone.replace(/\D/g,'')}" style="color:#27AE60;font-weight:600">💬 Chamar no WhatsApp</a></p>` : ''}
  </div>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: de,
      to: para.split(',').map((e) => e.trim()).filter(Boolean),
      subject: [
        '🔴 Parcela atrasada',
        pedido.school?.name,
        pedido.order_number ? `(${pedido.order_number})` : null,
      ].filter(Boolean).join(' — '),
      html,
    }),
  });
  if (!r.ok) throw new Error('Resend HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return { canal: 'email', enviado: true };
}

async function avisarParcelaAtrasada(pedido, parcela) {
  const res = await Promise.allSettled([avisarEmailParcelaAtrasada(pedido, parcela)]);
  res.forEach((r) => {
    if (r.status === 'rejected') console.error('aviso de parcela atrasada falhou:', r.reason?.message || r.reason);
    else if (!r.value.enviado) console.log(`aviso ${r.value.canal}: ${r.value.motivo}`);
  });
}

module.exports = { env, asaas, woovi, assinaturaWooviValida, sb, usuarioDoToken, valorComTaxa, apenasDigitos, telefoneBR, emDias, dividirProporcional, calcularDescontoIrmaos, calcularAcrescimoParcelamento, cancelarParcelasPix, resumoFinanceiro, liquidoCrivel, avisarVenda, avisarPedidoPendente, avisarPedidoCancelado, avisarPagamentoDesfeito, avisarParcelaPaga, avisarLembreteParcela, avisarParcelaAtrasada };
