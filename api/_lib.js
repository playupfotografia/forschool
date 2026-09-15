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

  const pagas = parcelas.filter(p => PAGO_OU_RECEBIDO.has(p.status));
  const liquido = pagas.reduce((s, p) => s + (Number(p.netValue) || 0), 0);

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

  // Defensivo de proposito: se este endpoint mudar ou responder diferente, a
  // conferencia perde a data da antecipacao, nunca a confirmacao do pedido.
  let antecipadoEm = null;
  let antecipacoes = [];
  if (!caiuEm) {
    try {
      const filtro = pag.installment
        ? `installment=${encodeURIComponent(pag.installment)}`
        : `payment=${encodeURIComponent(pag.id)}`;
      const ant = await asaas(`/anticipations?${filtro}&limit=100`);
      antecipacoes = ant?.data || [];
      const creditadas = antecipacoes.filter(a => ANTECIPACAO_CREDITADA.has(String(a.status || '').toUpperCase()));
      // So' conta como "ja' caiu" se TODAS as parcelas foram antecipadas e
      // creditadas — metade antecipada e' dinheiro pela metade.
      if (creditadas.length && creditadas.length >= parcelas.length) {
        antecipadoEm = creditadas
          .map(a => a.creditDate || a.anticipationDate || a.requestDate)
          .filter(Boolean).sort().pop() || null;
        caiuEm = antecipadoEm;
      }
    } catch (e) {
      console.error('antecipacoes:', e.message);
    }
  }

  return {
    liquido: Math.round(liquido * 100) / 100,
    previsto: previstas.length ? previstas[previstas.length - 1] : null,
    caiuEm,
    antecipadoEm,
    parcelas: parcelas.length,
    parcelasPagas: pagas.length,
    // So' pra diagnostico (o resync mostra ao admin). O webhook ignora.
    statusParcelas: parcelas.map(p => p.status),
    antecipacoes,
  };
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

module.exports = { env, asaas, sb, usuarioDoToken, valorComTaxa, apenasDigitos, telefoneBR, emDias, resumoFinanceiro, avisarVenda, avisarPedidoPendente, avisarPagamentoDesfeito };
