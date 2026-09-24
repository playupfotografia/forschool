// ============================================================================
// GET /api/cron-parcelas-atrasadas
//
// Robo diario do PIX parcelado (migration_058) — dispara sozinho pela Vercel
// Cron Jobs (ver "crons" em vercel.json), autenticado por CRON_SECRET: a
// propria Vercel manda "Authorization: Bearer $CRON_SECRET" quando o job de
// fato roda (nao e' possivel chamar essa rota de fora sem saber o segredo).
//
// Tres passos, cada parcela cai num so':
//   1. Lembrete por e-mail alguns dias antes do vencimento — so' informativo,
//      marcado em pix_installments.reminder_sent_at pra nao mandar 2x.
//   2. Passou da janela de graca da 1a cobranca sem pagar -> gera a "2a
//      tentativa": uma cobranca OVERDUE nova, com o mesmo acrescimo de
//      multa/juros ja embutido no valor (a cobranca original so' sabe
//      aplicar multa/juros DENTRO da propria janela de graca dela — depois
//      que expira, uma cobranca nova nao "lembra" que ja estava atrasada).
//   3. Passou da janela de graca da 2a tentativa sem pagar -> marca
//      'atrasada'. Sem 3a tentativa automatica: daqui pra frente e' o mesmo
//      fluxo manual (WhatsApp) que ja existe pro PIX manual comum.
// ============================================================================

const { sb, woovi, avisarLembreteParcela, avisarParcelaAtrasada } = require('./_lib.js');

const DIAS_GRACA = 5;    // igual ao daysAfterDueDate usado na criacao (criar-parcelamento-pix.js)
const DIAS_LEMBRETE = 3; // manda o lembrete quando faltam N dias pro vencimento
const MULTA_PCT = 200;   // 2,00% — mesmo valor de criar-parcelamento-pix.js
const JUROS_PCT = 100;   // 1,00%

function hojeISO() {
  return new Date().toISOString().slice(0, 10);
}
function diffDias(dataISO) {
  const hoje = new Date(hojeISO() + 'T00:00:00Z');
  const data = new Date(String(dataISO).slice(0, 10) + 'T00:00:00Z');
  return Math.round((data - hoje) / 86400000);
}

module.exports = async (req, res) => {
  const auth = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ erro: 'Nao autorizado.' });
  }

  const relatorio = { lembretes: 0, segundasTentativas: 0, atrasadas: 0, erros: [] };

  // ---- 1. Lembrete por e-mail, alguns dias antes do vencimento -------------
  try {
    const aVencer = await sb(
      '/pix_installments?status=eq.active&attempt=eq.1&reminder_sent_at=is.null&select=' +
      'id,order_id,installment_number,total_installments,value,due_date'
    );
    for (const p of (aVencer || [])) {
      if (diffDias(p.due_date) !== DIAS_LEMBRETE) continue;
      try {
        const pedidos = await sb(
          `/orders?id=eq.${encodeURIComponent(p.order_id)}&select=order_number,is_test,` +
          'student:students(name),school:schools(name),user:users(name,phone)'
        );
        const pedido = pedidos?.[0];
        if (pedido && !pedido.is_test) await avisarLembreteParcela(pedido, p);
        await sb(`/pix_installments?id=eq.${encodeURIComponent(p.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ reminder_sent_at: new Date().toISOString() }),
        });
        relatorio.lembretes++;
      } catch (e) {
        relatorio.erros.push(`lembrete ${p.id}: ${e.message}`);
      }
    }
  } catch (e) {
    relatorio.erros.push('busca de lembretes: ' + e.message);
  }

  // ---- 2. Passou da janela de graca da 1a cobranca -> gera a 2a tentativa --
  try {
    const vencidas1 = await sb(
      '/pix_installments?status=eq.active&attempt=eq.1&select=' +
      'id,order_id,installment_number,total_installments,value,due_date,gateway_id'
    );
    // Irmaos pagando junto (migration_059, Etapa 2): a mesma cobranca tem uma
    // linha por pedido do grupo, todas com o MESMO gateway_id. Agrupa por
    // cobranca pra gerar UMA 2a tentativa (com o total do grupo) em vez de
    // uma por linha — senao o pai receberia dois QRs pra mesma parcela.
    // Pedido solo: grupo de uma linha so', igual a antes.
    const porCobranca = new Map();
    for (const p of (vencidas1 || [])) {
      if (diffDias(p.due_date) >= -DIAS_GRACA) continue; // ainda dentro da janela de graca
      const chave = p.gateway_id || p.id;
      if (!porCobranca.has(chave)) porCobranca.set(chave, []);
      porCobranca.get(chave).push(p);
    }

    for (const [chave, linhas] of porCobranca) {
      const p = linhas[0];
      try {
        const ids = linhas.map((l) => encodeURIComponent(l.order_id)).join(',');
        const pedidos = await sb(
          `/orders?id=in.(${ids})&select=id,order_number,project_id,` +
          'user:users(name,email,cpf)'
        );
        const pedido = pedidos?.find((o) => o.id === p.order_id) || pedidos?.[0];
        if (!pedido) { relatorio.erros.push(`2a tentativa ${chave}: pedido nao encontrado`); continue; }

        let wooviConta = null;
        if (pedido.project_id) {
          const projs = await sb(`/projects?id=eq.${encodeURIComponent(pedido.project_id)}&select=woovi_conta`);
          wooviConta = projs?.[0]?.woovi_conta || null;
        }

        const resp = pedido.user || {};
        const cpf = String(resp.cpf || '').replace(/\D/g, '');
        // Acrescimo por linha (cada pedido guarda a sua fatia); a cobranca e'
        // a SOMA das fatias ja' arredondadas — assim bate centavo a centavo.
        const fatias = linhas.map((l) => Math.round(Number(l.value) * (1 + (MULTA_PCT + JUROS_PCT) / 10000) * 100) / 100);
        const valorComAcrescimo = Math.round(fatias.reduce((s, v) => s + v, 0) * 100) / 100;
        // Mesmo prefixo da cobranca original ("<pedido>" ou "grupo:<id>"), so'
        // pra ficar legivel no painel da Woovi — o webhook acha a parcela pelo
        // gateway_id exato gravado abaixo, nao por esse texto.
        const prefixo = String(p.gateway_id || '').startsWith('grupo:')
          ? String(p.gateway_id).replace(/-p\d+-\d+$/, '')
          : p.order_id;
        const correlationID = `${prefixo}-p${p.installment_number}-r2-${Date.now()}`;
        const dueDate = new Date().toISOString();
        const numeros = (pedidos || []).map((o) => o.order_number).filter(Boolean).join('+');

        const cob = await woovi('/api/v1/charge', {
          method: 'POST',
          body: JSON.stringify({
            correlationID,
            value: Math.round(valorComAcrescimo * 100),
            type: 'OVERDUE',
            dueDate,
            daysAfterDueDate: DIAS_GRACA,
            fines: { value: MULTA_PCT, type: 'PERCENTAGE' },
            interests: { value: JUROS_PCT, type: 'PERCENTAGE' },
            comment: `Pedido${linhas.length > 1 ? 's' : ''} ${numeros} - parcela ${p.installment_number}/${p.total_installments} - 2a tentativa`,
            customer: {
              name: resp.name || 'Responsavel',
              taxID: cpf || undefined,
              email: resp.email || undefined,
            },
          }),
        }, wooviConta);

        for (let i = 0; i < linhas.length; i++) {
          const l = linhas[i];
          await sb(`/pix_installments?id=eq.${encodeURIComponent(l.id)}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              attempt: 2,
              value: fatias[i],
              due_date: dueDate.slice(0, 10),
              gateway_id: correlationID,
              gateway_status: cob.charge?.status || null,
              pix_payload: cob.charge?.brCode || null,
              pix_qr_image: cob.charge?.qrCodeImage || null,
            }),
          });

          // Se nao existe parcela anterior pendente, essa e' a que a Minha
          // Area mostra hoje — atualiza o QR do pedido tambem (mesmo padrao
          // do webhook em woovi-webhook.js).
          const anteriores = await sb(
            `/pix_installments?order_id=eq.${encodeURIComponent(l.order_id)}&installment_number=lt.${l.installment_number}&status=not.in.(paid,cancelada)&select=id&limit=1`
          );
          if (!anteriores || anteriores.length === 0) {
            await sb(`/orders?id=eq.${encodeURIComponent(l.order_id)}`, {
              method: 'PATCH',
              headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({
                pix_payload: cob.charge?.brCode || null,
                pix_qr_image: cob.charge?.qrCodeImage || null,
              }),
            });
          }
        }

        relatorio.segundasTentativas++;
      } catch (e) {
        relatorio.erros.push(`2a tentativa ${chave}: ${e.message}`);
      }
    }
  } catch (e) {
    relatorio.erros.push('busca de 2as tentativas: ' + e.message);
  }

  // ---- 3. Passou da janela de graca da 2a tentativa -> atrasada ------------
  try {
    const vencidas2 = await sb(
      '/pix_installments?status=eq.active&attempt=eq.2&select=id,order_id,installment_number,total_installments,value,due_date'
    );
    for (const p of (vencidas2 || [])) {
      if (diffDias(p.due_date) >= -DIAS_GRACA) continue;
      try {
        await sb(`/pix_installments?id=eq.${encodeURIComponent(p.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'atrasada' }),
        });
        const pedidos = await sb(
          `/orders?id=eq.${encodeURIComponent(p.order_id)}&select=order_number,is_test,` +
          'student:students(name),school:schools(name),user:users(name,phone)'
        );
        const pedido = pedidos?.[0];
        if (pedido && !pedido.is_test) await avisarParcelaAtrasada(pedido, p);
        relatorio.atrasadas++;
      } catch (e) {
        relatorio.erros.push(`atrasada ${p.id}: ${e.message}`);
      }
    }
  } catch (e) {
    relatorio.erros.push('busca de atrasadas: ' + e.message);
  }

  if (relatorio.erros.length) console.error('cron-parcelas-atrasadas', relatorio.erros);
  return res.status(200).json({ ok: true, ...relatorio });
};
