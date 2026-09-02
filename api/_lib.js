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

module.exports = { env, asaas, sb, valorComTaxa, apenasDigitos, emDias };
