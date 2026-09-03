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
      subject: `💰 Venda ${pedido.order_number || ''} — ${moeda(pedido.amount_charged ?? pedido.total_amount)}`,
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

module.exports = { env, asaas, sb, usuarioDoToken, valorComTaxa, apenasDigitos, emDias, avisarVenda };
