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

// --- SumUp (so' o Pix) -----------------------------------------------------
// Autentica por Bearer token. Ha' uma unica URL: o que separa sandbox de
// producao e' a propria chave, nao o endereco.
async function sumup(caminho, opts = {}) {
  const base = (process.env.SUMUP_API_URL || 'https://api.sumup.com').replace(/\/$/, '');
  const r = await fetch(base + caminho, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + env('SUMUP_API_KEY'),
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const texto = await r.text();
  let corpo = null;
  try { corpo = texto ? JSON.parse(texto) : null; } catch { corpo = { raw: texto }; }
  if (!r.ok) {
    const msg = corpo?.message || corpo?.detail || corpo?.raw || `HTTP ${r.status}`;
    const e = new Error('SumUp: ' + msg);
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
// Confirma um checkout Pix da SumUp e devolve se o pedido virou pago.
//
// Dois caminhos chamam isto: o webhook (quando a SumUp avisa) e a consulta
// ativa do portal (quando ela nao avisa — que foi o que aconteceu no primeiro
// pagamento real: dinheiro entrou, aviso nunca chegou). A documentacao da
// SumUp manda reconsultar a API de qualquer forma, entao a verdade vem daqui e
// nunca do aviso recebido.
//
// E' seguro chamar varias vezes: se o pedido ja esta pago, sai sem regravar
// nem reenviar aviso de venda.
// ---------------------------------------------------------------------------
async function confirmarCheckoutSumup(checkoutId) {
  const checkout = await sumup(`/v0.1/checkouts/${encodeURIComponent(checkoutId)}`);

  // checkout_reference e' "<id do pedido>_<timestamp>" (o sufixo existe porque
  // a SumUp exige referencia unica por cobranca). Sem a checagem de formato,
  // uma referencia de outra origem viraria erro de UUID invalido no PostgREST.
  const ref = String(checkout.checkout_reference || '').split('_')[0];
  const ehUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  const filtro = ehUuid
    ? `id=eq.${ref}`
    : `gateway_id=eq.${encodeURIComponent(checkoutId)}`;

  const pedidos = await sb(
    `/orders?${filtro}&select=id,order_number,payment_status,payment_method,installments,` +
    'total_amount,amount_charged,student:students(name),school:schools(name),user:users(name,phone)'
  );
  const pedido = pedidos?.[0];
  if (!pedido) return { status: checkout.status, pedido: null, pago: false };
  if (pedido.payment_status === 'paid') return { status: checkout.status, pedido, pago: true };

  // O status do checkout nem sempre vira PAID: em alguns metodos a SumUp
  // mantem o checkout PENDING e registra o pagamento dentro de transactions
  // (e' assim no boleto). Aceitamos os dois, mas so' transacao concluida —
  // FAILED/PENDING ali nao confirmam nada.
  const trans = checkout.transactions || [];
  const pago = String(checkout.status || '').toUpperCase() === 'PAID'
    || trans.some((t) => ['SUCCESSFUL', 'PAID'].includes(String(t?.status || '').toUpperCase()));

  if (!pago) {
    // Se um pagamento real nao for reconhecido aqui, este log mostra o que a
    // SumUp respondeu de verdade — foi assim que descobrimos o formato do Pix.
    console.log('sumup checkout ainda nao pago:', JSON.stringify(checkout).slice(0, 800));
  }

  const patch = { gateway_status: checkout.status || null };

  if (pago) {
    patch.payment_status = 'paid';
    patch.paid_at = new Date().toISOString();
    // Quem pagou foi este checkout, entao o pedido tem que refletir isso — vale
    // pro caso do responsavel ter trocado de metodo e pago o Pix antigo.
    patch.gateway = 'sumup';
    patch.gateway_id = checkoutId;
    patch.payment_method = 'pix';
    patch.installments = 1;
    patch.amount_charged = Number(checkout.amount) || pedido.amount_charged || pedido.total_amount;
    patch.surcharge_amount = 0;
    // A SumUp nao informa liquido no checkout: net_amount/gateway_fee ficam
    // vazios. Nao faz falta — Pix na conta SumUp Bank nao tem tarifa.
  }

  await sb(`/orders?id=eq.${encodeURIComponent(pedido.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });

  // Depois de gravar, nunca antes: se o aviso falhar, o pedido ja esta pago.
  if (pago) {
    try {
      await avisarVenda({ ...pedido, ...patch });
    } catch (e) {
      console.error('avisarVenda', e.message);
    }
  }

  return { status: checkout.status, pedido, pago };
}

module.exports = { env, asaas, sumup, sb, usuarioDoToken, valorComTaxa, apenasDigitos, telefoneBR, emDias, avisarVenda, confirmarCheckoutSumup };
