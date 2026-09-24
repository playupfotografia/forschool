#!/usr/bin/env python3
"""
Montar Produtos — For School / Play Up Fotografia
==================================================
FASE 2: Lê a pasta organizada (Fase 1), você escolhe a foto de cada aluno,
e o sistema copia para pastas por produto conforme os pedidos no Supabase.

USO:
  python montar_produtos.py <pasta_organizada>

INSTALAR DEPENDÊNCIAS (uma única vez):
  pip install requests Pillow
"""

import sys
import os
import json
import shutil
import requests
from pathlib import Path
from datetime import datetime

# ── Credenciais Supabase ──────────────────────────────────────────────────────
# Esta e' a chave ANON, publica por design (a mesma que o site entrega pra
# qualquer visitante) — protegida pelas regras de RLS do banco. Pode ficar no
# codigo. NAO troque pela service_role: aquela da' acesso total e tem que
# ficar em supabase.local.env, como no ForSchool_Fotos.py.
SUPABASE_URL  = 'https://drxnaumaxcabjyfubuva.supabase.co'
SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRyeG5hdW1heGNhYmp5ZnVidXZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3ODc3OTcsImV4cCI6MjA5NjM2Mzc5N30.CtDJo-60rSrGlknX9DlpvDWuvnL8-yKeT6pYXXz--EM'

HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type': 'application/json',
}

EXTENSOES_FOTO = {'.jpg', '.jpeg', '.png', '.JPG', '.JPEG', '.PNG',
                  '.cr2', '.CR2', '.cr3', '.CR3', '.nef', '.NEF',
                  '.arw', '.ARW', '.orf', '.ORF', '.rw2', '.RW2'}


def supabase_get(table: str, params: dict) -> list:
    """Faz GET na API REST do Supabase."""
    url = f'{SUPABASE_URL}/rest/v1/{table}'
    r = requests.get(url, headers=HEADERS, params=params)
    r.raise_for_status()
    return r.json()


def buscar_pedido(aluno_id: str) -> list:
    """
    Retorna lista de produtos do pedido do aluno com quantidade.
    Formato: [{'produto': 'Foto 10x15', 'quantidade': 2}, ...]
    """
    if not aluno_id:
        return []

    # Busca orders do aluno
    # Mesma regra do ForSchool_Fotos.py: cancelado nao gera produto; vale o
    # pago mais recente, senao o mais recente em aberto.
    orders = supabase_get('orders', {
        'student_id': f'eq.{aluno_id}',
        'payment_status': 'not.in.(cancelled,refunded)',
        'select': 'id,payment_status',
        'order': 'created_at.desc',
    })
    if not orders:
        return []

    escolhido = next((o for o in orders if o.get('payment_status') == 'paid'), orders[0])
    order_id = escolhido['id']
    produtos = []
    vistos   = set()

    # Avulsos
    items = supabase_get('order_items', {
        'order_id': f'eq.{order_id}',
        'select': 'quantity,product:products(id,name)',
    })
    for it in items:
        p = it.get('product') or {}
        nome = p.get('name', '').strip()
        qty  = int(it.get('quantity') or 1)
        if nome and nome not in vistos:
            vistos.add(nome)
            produtos.append({'produto': nome, 'quantidade': qty})

    # Kits → achata os itens
    kits = supabase_get('order_kits', {
        'order_id': f'eq.{order_id}',
        'select': 'quantity,kit:school_kits(name,items:school_kit_items(quantity,product:products(id,name)))',
    })
    for ok in kits:
        kit_qty = int(ok.get('quantity') or 1)
        kit = ok.get('kit') or {}
        for ki in (kit.get('items') or []):
            p = ki.get('product') or {}
            nome = p.get('name', '').strip()
            item_qty = int(ki.get('quantity') or 1)
            if nome:
                # Se já existe (avulso + kit), soma
                existente = next((x for x in produtos if x['produto'] == nome), None)
                total = item_qty * kit_qty
                if existente:
                    existente['quantidade'] += total
                else:
                    produtos.append({'produto': nome, 'quantidade': total})

    return produtos


def listar_fotos(pasta: Path) -> list:
    """Lista fotos da pasta do aluno em ordem."""
    return sorted(
        [f for f in pasta.iterdir() if f.is_file() and f.suffix in EXTENSOES_FOTO],
        key=lambda f: f.name.lower()
    )


def escolher_foto(nome_aluno: str, fotos: list) -> Path | None:
    """Mostra fotos numeradas e pede ao usuário para escolher."""
    print(f'\n{"─"*55}')
    print(f'  Aluno: {nome_aluno}')
    print(f'{"─"*55}')

    if not fotos:
        print('  ⚠  Nenhuma foto encontrada nesta pasta. Pulando.')
        return None

    for i, f in enumerate(fotos, 1):
        print(f'  [{i}] {f.name}')

    print(f'  [0] Pular este aluno')
    print()

    while True:
        try:
            resp = input(f'  Qual foto usar? (1-{len(fotos)} ou 0 para pular): ').strip()
            n = int(resp)
            if n == 0:
                return None
            if 1 <= n <= len(fotos):
                return fotos[n - 1]
        except ValueError:
            pass
        print('  ❌ Digite um número válido.')


def copiar_para_produto(foto: Path, nome_aluno: str, nome_produto: str,
                        quantidade: int, pasta_produtos: Path):
    """Copia a foto N vezes para a pasta do produto."""
    pasta_prod = pasta_produtos / sanitizar_pasta(nome_produto)
    pasta_prod.mkdir(parents=True, exist_ok=True)

    ext = foto.suffix
    base = sanitizar_pasta(nome_aluno)

    for i in range(1, quantidade + 1):
        sufixo = f'_{i}' if quantidade > 1 else ''
        destino = pasta_prod / f'{base}{sufixo}{ext}'
        shutil.copy2(foto, destino)

    label = f'{quantidade}x' if quantidade > 1 else '1x'
    print(f'     ✓  {nome_produto}: {label} → {pasta_prod.name}/')


def sanitizar_pasta(nome: str) -> str:
    for c in r'<>:"/\|?*':
        nome = nome.replace(c, '_')
    return nome.strip('. ')[:60] or 'Produto'


def gerar_relatorio(relatorio: dict, pasta_saida: Path, data: str):
    """Salva relatório de impressão em arquivo texto."""
    path = pasta_saida / '_RELATORIO_IMPRESSAO.txt'
    with open(path, 'w', encoding='utf-8') as f:
        f.write('=' * 55 + '\n')
        f.write('  RELATÓRIO DE IMPRESSÃO — For School\n')
        f.write(f'  Gerado em: {data}\n')
        f.write('=' * 55 + '\n\n')

        if not relatorio:
            f.write('Nenhum produto para imprimir.\n')
            return path

        total_geral = 0
        for produto, dados in sorted(relatorio.items()):
            total = dados['total']
            total_geral += total
            f.write(f'  {produto:<35} {total:>4} unidade(s)\n')
            for aluno, qty in sorted(dados['alunos'].items()):
                f.write(f'       • {aluno:<30} {qty}x\n')
            f.write('\n')

        f.write('─' * 55 + '\n')
        f.write(f'  TOTAL GERAL: {total_geral} arquivo(s)\n')
        f.write('=' * 55 + '\n')

    return path


def processar(pasta_organizada: Path):
    print(f'\n{"="*60}')
    print('   For School — FASE 2: Montar Produtos')
    print(f'{"="*60}')
    print(f'   Pasta: {pasta_organizada}')
    print(f'{"="*60}')

    # Descobre subpastas de alunos (ignora _PRODUTOS, _sem_aluno, etc.)
    pastas_alunos = sorted([
        p for p in pasta_organizada.iterdir()
        if p.is_dir() and not p.name.startswith('_')
    ], key=lambda p: p.name.lower())

    if not pastas_alunos:
        print('\n❌  Nenhuma pasta de aluno encontrada.')
        print('    Execute primeiro o 2_ORGANIZAR.bat')
        return

    print(f'\n   {len(pastas_alunos)} pasta(s) de aluno(s) encontrada(s).')

    # Tenta ler IDs dos alunos do arquivo de índice (se existir)
    indice_path = pasta_organizada / '_indice_alunos.json'
    indice = {}
    if indice_path.exists():
        with open(indice_path, encoding='utf-8') as f:
            indice = json.load(f)

    pasta_produtos = pasta_organizada / '_PRODUTOS'
    pasta_produtos.mkdir(exist_ok=True)

    relatorio = {}   # produto → {total, alunos: {nome: qty}}
    pulados   = []
    sem_pedido = []

    for pasta in pastas_alunos:
        nome_pasta = pasta.name
        info = indice.get(nome_pasta, {})
        aluno_id   = info.get('id', '')
        nome_aluno = info.get('nome', nome_pasta)

        fotos = listar_fotos(pasta)
        foto_escolhida = escolher_foto(nome_aluno or nome_pasta, fotos)

        if foto_escolhida is None:
            pulados.append(nome_pasta)
            continue

        # Busca pedido no Supabase
        print(f'  🔍 Buscando pedido...', end=' ', flush=True)
        try:
            produtos_pedido = buscar_pedido(aluno_id)
        except Exception as e:
            print(f'ERRO: {e}')
            produtos_pedido = []

        if not produtos_pedido:
            print('sem pedido cadastrado.')
            sem_pedido.append(nome_pasta)
            continue

        print(f'{len(produtos_pedido)} produto(s)')

        # Copia foto para cada pasta de produto × quantidade
        for item in produtos_pedido:
            nome_prod = item['produto']
            qty       = item['quantidade']
            copiar_para_produto(foto_escolhida, nome_aluno or nome_pasta,
                                nome_prod, qty, pasta_produtos)

            # Acumula no relatório
            if nome_prod not in relatorio:
                relatorio[nome_prod] = {'total': 0, 'alunos': {}}
            relatorio[nome_prod]['total'] += qty
            relatorio[nome_prod]['alunos'][nome_aluno or nome_pasta] = qty

    # Gera relatório
    data_str = datetime.now().strftime('%d/%m/%Y %H:%M')
    rel_path = gerar_relatorio(relatorio, pasta_organizada, data_str)

    print(f'\n{"="*60}')
    print('   RELATÓRIO DE IMPRESSÃO')
    print(f'{"="*60}')
    for produto, dados in sorted(relatorio.items()):
        print(f'   {produto:<35} {dados["total"]:>4} unidade(s)')
    if pulados:
        print(f'\n   ⏭  Pulados: {len(pulados)} aluno(s)')
    if sem_pedido:
        print(f'   ❓  Sem pedido: {len(sem_pedido)} aluno(s)')

    print(f'\n   📄 Relatório salvo em: {rel_path.name}')
    print(f'   📁 Pastas de produto em: _PRODUTOS/')
    print(f'\n   ✅ Fase 2 concluída!\n')

    # Abre a pasta no explorador
    try:
        if sys.platform == 'win32':
            os.startfile(str(pasta_organizada))
    except Exception:
        pass


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        input('\nPressione Enter para fechar...')
        sys.exit(0)

    pasta = Path(sys.argv[1])
    if not pasta.exists():
        print(f'\n❌  Pasta não encontrada: {pasta}')
        input('\nPressione Enter para fechar...')
        sys.exit(1)

    try:
        processar(pasta)
    except KeyboardInterrupt:
        print('\n\nInterrompido pelo usuário.')

    input('\nPressione Enter para fechar...')
