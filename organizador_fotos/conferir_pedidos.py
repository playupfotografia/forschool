"""Conferencia: pedidos x fotos prontas pra imprimir.

SO' LE (banco e pastas). Nao move, nao apaga, nao altera nada — so' grava o
relatorio  _CONFERENCIA.html  (e .csv) dentro da pasta organizada.

Uso:   python conferir_pedidos.py "<pasta organizada>" [--projeto PREFIXO_DO_ID]

O que ele compara, por produto e por aluno:
  PEDIDOS     = o que o banco diz (kits abertos nos produtos que levam).
                Separa PAGOS de PENDENTES — o "Montar e salvar tudo" monta os dois
                (pago, ou o pedido aberto mais recente), entao os dois contam.
  ENCONTRADO  = arquivos que estao em _PRODUTOS/<produto>/ (se ja' rodou a montagem)
e aponta tudo que nao fecha: aluno com pedido sem pasta ligada ao cadastro, tema
comprado sem foto escolhida, turma sem foto de turma, arquivo sobrando ou faltando.
"""
import sys, os, json, csv, html, re, unicodedata, warnings
from pathlib import Path
from datetime import datetime

import requests
warnings.filterwarnings('ignore')

AQUI = Path(__file__).parent
env = {}
for l in open(AQUI / 'supabase.local.env', encoding='utf-8'):
    if '=' in l and not l.startswith('#'):
        k, v = l.strip().split('=', 1)
        env[k.strip()] = v.strip()
URL, KEY = env['SUPABASE_URL'], env['SUPABASE_SERVICE_KEY']
H = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY}


def get(tabela, params):
    out, ini = [], 0
    while True:
        r = requests.get(f'{URL}/rest/v1/{tabela}', params=params, timeout=30, verify=False,
                         headers={**H, 'Range-Unit': 'items', 'Range': f'{ini}-{ini + 999}'})
        r.raise_for_status()
        lote = r.json()
        out += lote
        if len(lote) < 1000:
            return out
        ini += 1000


def sanitizar(nome, max_len=60):
    for c in '<>:"/\\|?*':
        nome = nome.replace(c, '_')
    return nome.strip('. ')[:max_len].strip('. ') or 'Aluno'


def norm(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s or '') if unicodedata.category(c) != 'Mn').casefold()


def chave_turma(s):
    """'3° Ano Fund I - Turma A' e '3° Fund I - Turma A Professora X' passam a se parecer."""
    return ' '.join(w for w in norm(s).split() if w != 'ano')


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__); sys.exit(1)
    pasta = Path(args[0])
    prefixo = args[args.index('--projeto') + 1] if '--projeto' in args else None
    indice = json.load(open(pasta / '_indice_alunos.json', encoding='utf-8'))
    escolhas = {}
    if (pasta / '_escolhas.json').exists():
        escolhas = json.load(open(pasta / '_escolhas.json', encoding='utf-8'))

    ids_pasta = {v.get('id') for v in indice.values() if v.get('id')}
    pedidos = get('orders', {
        'select': 'id,order_number,payment_status,is_test,project_id,student_id,created_at,'
                  'student:students(id,name,class:school_classes(name,year:school_years(name))),'
                  'project:projects(name),'
                  'items:order_items(quantity,variant_name,from_kit_id,product:products(name,photo_theme),variant:product_variants(photo_theme)),'
                  'kits:order_kits(quantity,kit:school_kits(name,items:school_kit_items(quantity,product:products(name,photo_theme))))',
        'is_test': 'not.is.true'})
    if prefixo:
        pedidos = [p for p in pedidos if (p.get('project_id') or '').startswith(prefixo)]
    else:
        cont = {}
        for p in pedidos:
            if p['student_id'] in ids_pasta and p.get('project_id'):
                cont[p['project_id']] = cont.get(p['project_id'], 0) + 1
        alvo = max(cont, key=cont.get) if cont else None
        pedidos = [p for p in pedidos if p.get('project_id') == alvo]
    if not pedidos:
        print('Nenhum pedido encontrado pra esta pasta.'); sys.exit(1)
    projeto_nome = pedidos[0]['project']['name']
    pedidos = [p for p in pedidos if p['payment_status'] in ('paid', 'pending')]

    # ── PEDIDOS: por aluno e por produto (pago x pendente) ────────────────────
    esperado = {}
    for p in sorted(pedidos, key=lambda p: p['created_at']):
        cl = p['student'].get('class') or {}
        e = esperado.setdefault(p['student_id'], {
            'nome': p['student']['name'],
            'turma': ((cl.get('year') or {}).get('name', '') + ' ' + cl.get('name', '')).strip(),
            'pedido': p['order_number'], 'status': p['payment_status'], 'prod': {}, 'kits': []})
        e['pedido'], e['status'] = p['order_number'], p['payment_status']
        pago = p['payment_status'] == 'paid'
        tem_kit = bool(p['kits'])

        def soma(chave, base, tema, q):
            d = e['prod'].setdefault(chave, {'qp': 0, 'qa': 0, 'tema': tema, 'base': base})
            d['qa'] += q
            if pago:
                d['qp'] += q
        for it in p['items']:
            if it.get('from_kit_id') and tem_kit:
                continue
            nome = ((it.get('product') or {}).get('name') or '').strip()
            if not nome:
                continue
            tema = ((it.get('variant') or {}).get('photo_theme') or (it.get('product') or {}).get('photo_theme') or '').strip()
            soma(nome + (f" — {it['variant_name']}" if it.get('variant_name') else ''), nome, tema, int(it.get('quantity') or 1))
        for k in p['kits']:
            kq = int(k.get('quantity') or 1)
            e['kits'].append(f"{(k.get('kit') or {}).get('name', '?')} x{kq}")
            for ki in (k.get('kit') or {}).get('items') or []:
                nome = ((ki.get('product') or {}).get('name') or '').strip()
                if nome:
                    soma(nome, nome, ((ki.get('product') or {}).get('photo_theme') or '').strip(),
                         int(ki.get('quantity') or 1) * kq)

    total = {}
    for e in esperado.values():
        for n, d in e['prod'].items():
            t = total.setdefault(n, {'p': 0, 'a': 0})
            t['p'] += d['qp']; t['a'] += d['qa']

    # ── Pastas / escolhas ──────────────────────────────────────────────────────
    por_id, duplicadas = {}, []
    for chave, v in indice.items():
        if v.get('id'):
            if v['id'] in por_id:
                duplicadas.append((v['nome'], por_id[v['id']], chave))
            por_id[v['id']] = chave
    turmas = {}
    raiz_t = pasta / '_TURMAS'
    if raiz_t.exists():
        for sub in raiz_t.iterdir():
            if sub.is_dir():
                turmas[sub.name] = len([f for f in sub.iterdir() if f.is_file()])

    def turma_do_aluno(info):
        ano, t = (info.get('ano') or '').strip(), (info.get('turma') or '').strip()
        partes = [x for x in (ano, f'Turma {t}' if t else '') if x]
        if not partes:
            return None
        alvo = chave_turma(sanitizar(' - '.join(partes)))
        for n in turmas:
            if chave_turma(n) == alvo:
                return n
        for n in turmas:
            cn = chave_turma(n)
            if cn.startswith(alvo) or alvo.startswith(cn):
                return n
        return None

    problemas, linhas = [], []
    for sid, e in sorted(esperado.items(), key=lambda kv: norm(kv[1]['nome'])):
        rotulo_pend = ' (pedido PENDENTE)' if e['status'] != 'paid' else ''
        chave = por_id.get(sid)
        if not chave:
            problemas.append(('ERRO', e['nome'], f"tem pedido {e['pedido']}{rotulo_pend} mas NÃO tem pasta ligada ao cadastro — as fotos dele não entram nos produtos"))
            linhas.append({**e, 'fotos': 0, 'obs': 'SEM PASTA LIGADA'})
            continue
        info = indice[chave]
        d_aluno = pasta / chave
        n_fotos = len([f for f in d_aluno.glob('*') if f.is_file()]) if d_aluno.exists() else 0
        if n_fotos == 0:
            problemas.append(('ERRO', e['nome'], f"tem pedido {e['pedido']}{rotulo_pend} mas a pasta está vazia"))
        esc = escolhas.get(chave, {})
        obs = []
        for n, d in e['prod'].items():
            tema = d['tema']
            if 'turma' in d['base'].lower():
                tn = turma_do_aluno(info)
                if not tn:
                    problemas.append(('ERRO', e['nome'], f'"{n}": não existe pasta da turma dele ({e["turma"]}) em _TURMAS — a Foto Turma sairia com a foto do próprio aluno'))
                    obs.append('sem pasta de turma')
                elif not escolhas.get('TURMA::' + tn, {}).get(''):
                    problemas.append(('AVISO', e['nome'], f'"{n}": a turma "{tn}" não tem foto escolhida (usaria a 1ª)'))
                    obs.append('turma sem escolha')
                continue
            usada = esc.get(tema) or esc.get('')
            if not usada:
                problemas.append(('AVISO', e['nome'], f'"{n}" [{tema or "uniforme"}]: sem foto escolhida — usaria a 1ª da pasta'))
                obs.append('sem escolha')
            elif tema and not esc.get(tema):
                problemas.append(('AVISO', e['nome'], f'"{n}": sem foto do tema "{tema}" — usaria a de uniforme'))
                obs.append('tema sem escolha')
            if usada and not (d_aluno / usada).exists():
                problemas.append(('ERRO', e['nome'], f'"{n}": a foto escolhida ({usada}) não existe mais na pasta'))
                obs.append('foto escolhida sumiu')
        linhas.append({**e, 'fotos': n_fotos, 'obs': '; '.join(sorted(set(obs))) or 'ok'})

    for nome, a, b in duplicadas:
        problemas.append(('AVISO', nome, f'duas pastas ligadas ao mesmo aluno: "{a}" e "{b}"'))
    so_pasta = [indice[k]['nome'] for k, v in indice.items() if v.get('id') and v['id'] not in esperado]

    # ── _PRODUTOS: o que foi realmente montado, aluno por aluno ───────────────
    pp = pasta / '_PRODUTOS'
    montado = pp.exists()
    achado_prod, achado_aluno, desconhecidos, dir_prod = {}, {}, [], {}
    if montado:
        mapa_nomes = {}
        for chave, v in indice.items():
            mapa_nomes.setdefault(sanitizar(v.get('nome', chave)), []).append(v.get('id') or chave)
        prod_por_dir = {sanitizar(n.split(' — ')[0]): n.split(' — ')[0] for n in total}
        for sub in sorted(pp.iterdir()):
            if not sub.is_dir():
                continue
            nomeprod = prod_por_dir.get(sub.name)
            arqs = [f for f in sub.iterdir() if f.is_file()]
            if nomeprod is None:
                desconhecidos.append((sub.name, len(arqs)))
                continue
            dir_prod[nomeprod] = len(arqs)
            for f in arqs:
                base = re.sub(r'_\d+$', '', f.stem)
                ids_ = mapa_nomes.get(base)
                if not ids_:
                    problemas.append(('AVISO', base, f'arquivo em _PRODUTOS/{sub.name} que não corresponde a nenhum aluno da pasta'))
                    continue
                k2 = (ids_[0], nomeprod)
                achado_aluno[k2] = achado_aluno.get(k2, 0) + 1
        # diferencas por aluno
        for sid, e in esperado.items():
            chave = por_id.get(sid)
            if not chave:
                continue
            for n, d in e['prod'].items():
                bn = n.split(' — ')[0]
                if n != bn and n in e['prod'] and bn in e['prod']:
                    continue
            agreg = {}
            for n, d in e['prod'].items():
                bn = n.split(' — ')[0]
                agreg[bn] = agreg.get(bn, 0) + d['qa']
            for bn, q in agreg.items():
                f = achado_aluno.get((sid, bn), 0)
                if f != q:
                    problemas.append(('ERRO', e['nome'], f'"{bn}": pedido pede {q}, mas há {f} arquivo(s) em _PRODUTOS'))
        for (sid, bn), f in achado_aluno.items():
            e = esperado.get(sid)
            if (not e) or all(n.split(' — ')[0] != bn for n in e['prod']):
                nome = indice.get(por_id.get(sid, ''), {}).get('nome', sid)
                problemas.append(('ERRO', nome, f'"{bn}": {f} arquivo(s) em _PRODUTOS sem pedido correspondente (pago ou pendente)'))

    # pendentes que foram montados (decisao do Daniel: imprime ou espera pagar?)
    pend_montados = []
    if montado:
        for sid, e in esperado.items():
            if e['status'] != 'paid' and por_id.get(sid) and any(achado_aluno.get((sid, n.split(' — ')[0])) for n in e['prod']):
                pend_montados.append(f"{e['nome']} ({e['pedido']})")

    # ── Relatorio ──────────────────────────────────────────────────────────────
    gerado = datetime.now().strftime('%d/%m/%Y %H:%M')
    esc_ = html.escape
    agreg_total = {}
    for n, t in total.items():
        bn = n.split(' — ')[0]
        a = agreg_total.setdefault(bn, {'p': 0, 'a': 0})
        a['p'] += t['p']; a['a'] += t['a']
    linhas_prod = []
    for bn, t in sorted(agreg_total.items(), key=lambda kv: norm(kv[0])):
        if not montado:
            enc, st = '—', '<span class="pen">ainda não montado</span>'
        else:
            enc = dir_prod.get(bn, 0)
            st = '<span class="ok">OK</span>' if enc == t['a'] else f'<span class="err">DIFERENÇA {enc - t["a"]:+d}</span>'
        linhas_prod.append((bn, t['p'], t['a'] - t['p'], t['a'], enc, st))
    n_erros = sum(1 for p in problemas if p[0] == 'ERRO')
    n_av = sum(1 for p in problemas if p[0] == 'AVISO')
    veredito = '✅ TUDO CONFERE' if not problemas else f'⚠ {n_erros} erro(s) e {n_av} aviso(s) — ver a lista abaixo'
    n_pagos = sum(1 for p in pedidos if p['payment_status'] == 'paid')

    def _linha_html(l):
        prod_txt = ' · '.join('%sx %s' % (d['qa'], n) for n, d in l['prod'].items())
        kit_txt = ', '.join(l['kits']) or 'só avulsos'
        cls = 'ok' if l['obs'] == 'ok' else 'err'
        st = 'Pago' if l['status'] == 'paid' else 'PENDENTE'
        return ('<tr><td>%s</td><td>%s</td><td>%s %s</td><td>%s<br><span style="color:#666">%s</span></td><td>%s</td><td class="%s">%s</td></tr>'
                % (esc_(l['nome']), esc_(l['turma']), esc_(l['pedido']), st, esc_(kit_txt), esc_(prod_txt), l['fotos'], cls, esc_(l['obs'])))
    linhas_html = ''.join(_linha_html(l) for l in linhas)
    prod_html = ''.join('<tr><td>%s</td><td>%s</td><td>%s</td><td><b>%s</b></td><td>%s</td><td>%s</td></tr>' % (esc_(bn), p, pe, a, enc, st)
                        for bn, p, pe, a, enc, st in linhas_prod)
    prob_html = ('<div class="ok">Nenhum problema encontrado.</div>' if not problemas else
                 '<table><tr><th>Nível</th><th>Aluno</th><th>O que está errado</th></tr>' +
                 ''.join('<tr><td class="%s">%s</td><td>%s</td><td>%s</td></tr>' % ('err' if g == 'ERRO' else 'pen', g, esc_(a), esc_(t)) for g, a, t in problemas) + '</table>')
    extra = ''
    if desconhecidos:
        extra += '<h2>Outras pastas dentro de _PRODUTOS (não são produtos deste projeto)</h2><div style="color:#555">%s</div>' % esc_(', '.join(f'{n} ({q} arq.)' for n, q in desconhecidos))
    if pend_montados:
        extra += '<h2>Pedidos PENDENTES que já foram montados em _PRODUTOS (%d)</h2><div style="color:#555">O programa monta o pedido aberto mais recente de quem ainda não pagou. Decida se imprime só depois de pagar.<br>%s</div>' % (len(pend_montados), esc_(', '.join(pend_montados)))
    doc = f"""<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Conferência — {esc_(projeto_nome)}</title>
<style>body{{font-family:Arial,sans-serif;font-size:12.5px;color:#1a1a2e;margin:18px}}h1{{font-size:18px}}h2{{font-size:14px;margin:18px 0 6px;border-left:4px solid #4B6BFB;padding-left:8px}}
table{{border-collapse:collapse;width:100%}}th{{text-align:left;font-size:10px;text-transform:uppercase;color:#777;border-bottom:1px solid #ccc;padding:4px}}td{{padding:4px;border-bottom:1px solid #eee;vertical-align:top}}
.ok{{color:#1A6B3C;font-weight:700}}.err{{color:#B91C1C;font-weight:700}}.pen{{color:#854D0E;font-weight:700}}.box{{padding:10px 14px;border-radius:8px;font-weight:700;font-size:15px;margin:10px 0;background:{'#ECFDF5' if not problemas else '#FEF2F2'}}}
@media print{{body{{margin:8mm}}}}</style></head><body>
<h1>Conferência de pedidos × fotos — {esc_(projeto_nome)}</h1>
<div>Gerado em {gerado} · pasta: {esc_(str(pasta))}</div>
<div class="box">{veredito}</div>
<div>Pedidos: <b>{len(pedidos)}</b> ({n_pagos} pagos + {len(pedidos) - n_pagos} pendentes) · alunos com pedido: <b>{len(esperado)}</b> · com pasta ligada ao cadastro: <b>{sum(1 for s in esperado if s in por_id)}</b> · unidades (pagos+pendentes): <b>{sum(t['a'] for t in agreg_total.values())}</b></div>
<h2>1. Produto por produto</h2>
<table><tr><th>Produto</th><th>Pagos</th><th>Pendentes</th><th>Pagos + pendentes</th><th>Encontrado em _PRODUTOS</th><th>Situação</th></tr>{prod_html}</table>
<h2>2. Problemas ({len(problemas)})</h2>{prob_html}{extra}
<h2>3. Aluno por aluno</h2>
<table><tr><th>Aluno</th><th>Turma</th><th>Pedido</th><th>Kit / produtos</th><th>Fotos na pasta</th><th>Situação</th></tr>{linhas_html}</table>
<h2>4. Alunos com pasta mas SEM pedido pago ou pendente ({len(so_pasta)})</h2>
<div style="color:#555">{esc_(', '.join(sorted(so_pasta, key=norm)) or '—')}</div>
</body></html>"""
    (pasta / '_CONFERENCIA.html').write_text(doc, encoding='utf-8')
    with open(pasta / '_CONFERENCIA.csv', 'w', encoding='utf-8-sig', newline='') as fh:
        w = csv.writer(fh, delimiter=';')
        w.writerow(['aluno', 'turma', 'pedido', 'status', 'kits', 'produto', 'qtd_paga', 'qtd_total', 'tema', 'fotos_na_pasta', 'situacao'])
        for l in linhas:
            for n, d in l['prod'].items():
                w.writerow([l['nome'], l['turma'], l['pedido'], l['status'], '; '.join(l['kits']), n, d['qp'], d['qa'], d['tema'], l['fotos'], l['obs']])

    print(f'Projeto: {projeto_nome}')
    print(f'Pedidos: {len(pedidos)} ({n_pagos} pagos + {len(pedidos) - n_pagos} pendentes) | alunos: {len(esperado)} | unidades: {sum(t["a"] for t in agreg_total.values())}')
    print(f'Alunos com pedido SEM pasta ligada: {sum(1 for s in esperado if s not in por_id)}')
    print(f'Problemas: {n_erros} erro(s), {n_av} aviso(s)')
    for g, a, t in problemas:
        print(f'  [{g}] {a}: {t}')
    if pend_montados:
        print('Pendentes ja montados:', ', '.join(pend_montados))
    if montado:
        print('\nProduto | pagos | pendentes | total | encontrado')
        for bn, p, pe, a, enc, st in linhas_prod:
            print(f'  {bn[:48]:48} {p:>3} {pe:>3} {a:>3} | {enc:>3}  {re.sub("<.*?>", "", st)}')
    print('\nRelatorio:', pasta / '_CONFERENCIA.html')


if __name__ == '__main__':
    main()
