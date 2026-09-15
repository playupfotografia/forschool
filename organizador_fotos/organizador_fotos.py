#!/usr/bin/env python3
"""
Organizador de Fotos — For School / Play Up Fotografia
=======================================================
FASE 1: Lê fotos do cartão de memória e organiza por aluno via QR code.

USO:
  python organizador_fotos.py <pasta_origem> [pasta_saida]

INSTALAR DEPENDÊNCIAS (uma única vez):
  pip install opencv-python Pillow requests
"""

import cv2
import json
import os
import sys
import shutil
from pathlib import Path
from datetime import datetime

EXTENSOES = {
    '.jpg', '.jpeg', '.JPG', '.JPEG',
    '.png', '.PNG',
    '.cr2', '.CR2', '.cr3', '.CR3',
    '.nef', '.NEF', '.arw', '.ARW',
    '.orf', '.ORF', '.rw2', '.RW2',
}


def ler_qr(caminho: Path) -> dict | None:
    img = cv2.imread(str(caminho))
    if img is None:
        return None
    detector = cv2.QRCodeDetector()
    h, w = img.shape[:2]
    for escala in [0.15, 0.30, 0.60, 1.0]:
        if escala < 1.0:
            novo_w = max(int(w * escala), 400)
            novo_h = max(int(h * escala), 300)
            img_proc = cv2.resize(img, (novo_w, novo_h), interpolation=cv2.INTER_AREA)
        else:
            img_proc = img
        dados, _, _ = detector.detectAndDecode(img_proc)
        if dados:
            try:
                return json.loads(dados)
            except json.JSONDecodeError:
                return {'n': dados.strip()}
    return None


def sanitizar_nome(nome: str) -> str:
    for c in r'<>:"/\|?*':
        nome = nome.replace(c, '_')
    nome = nome.strip('. ')
    return nome[:80] or 'Aluno'


def organizar(pasta_origem: Path, pasta_saida: Path):
    pasta_saida.mkdir(parents=True, exist_ok=True)

    fotos = sorted(
        [f for f in pasta_origem.iterdir() if f.suffix in EXTENSOES],
        key=lambda f: f.name.lower()
    )

    if not fotos:
        print(f'\n❌  Nenhuma foto encontrada em: {pasta_origem}')
        return {}

    print(f'\n{"="*60}')
    print('   For School — FASE 1: Organizar por aluno')
    print(f'{"="*60}')
    print(f'   Origem : {pasta_origem}')
    print(f'   Saída  : {pasta_saida}')
    print(f'   Total  : {len(fotos)} foto(s)')
    print(f'{"="*60}\n')

    aluno_atual   = None
    pasta_aluno   = None
    fotos_aluno   = 0
    alunos_info   = {}   # nome_pasta → {id, nome, turma, escola, fotos:[]}
    sem_aluno     = 0
    pasta_sem     = pasta_saida / '_sem_aluno'

    turmas_info = {}   # nome_pasta -> quantas fotos de turma

    for i, foto in enumerate(fotos, 1):
        prefixo = f'[{i:4}/{len(fotos)}] {foto.name[:38]:<38}'
        print(prefixo, end=' ', flush=True)

        dados = ler_qr(foto)

        # QR de TURMA (cartao "foto de turma", gerado no admin). Marca o inicio
        # das fotos coletivas: elas nao pertencem a aluno nenhum, e sem isso
        # cairiam na pasta do ultimo aluno fotografado.
        if dados and str(dados.get('tipo', '')).lower() == 'turma':
            turma   = dados.get('turma', dados.get('t', ''))
            ano     = dados.get('ano', dados.get('a', ''))
            periodo = dados.get('periodo', dados.get('p', ''))

            if aluno_atual and aluno_atual in alunos_info:
                alunos_info[aluno_atual]['fotos_count'] = fotos_aluno

            partes = [p for p in [ano, f'Turma {turma}' if turma else ''] if p]
            nome_pasta = sanitizar_nome(' - '.join(partes)) or 'Turma'
            pasta_aluno = pasta_saida / '_TURMAS' / nome_pasta
            pasta_aluno.mkdir(parents=True, exist_ok=True)

            # aluno_atual = None diz ao resto do laco "as proximas fotos nao
            # sao de aluno": sao copiadas, mas nao entram no indice.
            aluno_atual = None
            fotos_aluno = 0
            turmas_info.setdefault(nome_pasta, 0)
            print(f'🏫 QR TURMA → {nome_pasta}' + (f'  ({periodo})' if periodo else ''))
            continue

        if dados:
            nome   = dados.get('nome', dados.get('n', 'Desconhecido'))
            turma  = dados.get('turma', dados.get('t', ''))
            escola = dados.get('escola', dados.get('e', ''))
            ano    = dados.get('ano', dados.get('a', ''))
            aluno_id = dados.get('id', '')

            if aluno_atual and aluno_atual in alunos_info:
                alunos_info[aluno_atual]['fotos_count'] = fotos_aluno

            # Nome da pasta inclui ano e turma
            partes = [nome]
            if ano:   partes.append(ano)
            if turma: partes.append(f'Turma {turma}')
            nome_pasta = sanitizar_nome(' - '.join(partes))

            aluno_atual = nome_pasta
            pasta_aluno = pasta_saida / nome_pasta
            pasta_aluno.mkdir(exist_ok=True)

            # Mesmo aluno volta varias vezes no dia (um QR por tema de foto).
            # Recriar o registro aqui apagava as fotos ja' listadas.
            ja_visto = nome_pasta in alunos_info
            if ja_visto:
                fotos_aluno = alunos_info[nome_pasta].get('fotos_count', 0)
                alunos_info[nome_pasta]['bloco_atual'] += 1
            else:
                fotos_aluno = 0
                alunos_info[nome_pasta] = {
                    'id': aluno_id,
                    'nome': nome,
                    'turma': turma,
                    'ano': ano,
                    'escola': escola,
                    'pasta': pasta_aluno,
                    'fotos': [],
                    'blocos': [],
                    'bloco_atual': 1,
                    'fotos_count': 0,
                }

            bloco = alunos_info[nome_pasta]['bloco_atual']
            info = f' ({ano} - Turma {turma})' if ano and turma else f' ({turma})' if turma else ''
            print(f'📋 QR → {nome}{info}' + (f'  (bloco {bloco})' if ja_visto else ''))

        elif pasta_aluno is not None:
            fotos_aluno += 1
            destino = pasta_aluno / foto.name
            shutil.copy2(foto, destino)
            # aluno_atual None = foto de turma: copia, mas nao registra no
            # indice (foto de turma nao vira produto de aluno).
            if aluno_atual and aluno_atual in alunos_info:
                if destino not in alunos_info[aluno_atual]['fotos']:
                    alunos_info[aluno_atual]['fotos'].append(destino)
                    alunos_info[aluno_atual]['blocos'].append(
                        alunos_info[aluno_atual]['bloco_atual'])
                print(f'✓  → {aluno_atual} (foto {fotos_aluno})')
            else:
                turmas_info[pasta_aluno.name] = turmas_info.get(pasta_aluno.name, 0) + 1
                print(f'✓  → _TURMAS/{pasta_aluno.name} (foto {fotos_aluno})')

        else:
            sem_aluno += 1
            pasta_sem.mkdir(exist_ok=True)
            shutil.copy2(foto, pasta_sem / foto.name)
            print('⚠  (antes do 1º QR → _sem_aluno)')

    if aluno_atual and aluno_atual in alunos_info:
        alunos_info[aluno_atual]['fotos_count'] = fotos_aluno

    print(f'\n{"="*60}')
    print('   RESUMO — FASE 1')
    print(f'{"="*60}')
    for nome_pasta, info in alunos_info.items():
        qtd = len(info['fotos'])
        print(f'   {info["nome"]:<35} {qtd} foto(s)')
    for nome_t, qtd in turmas_info.items():
        print(f'   🏫 _TURMAS/{nome_t:<26} {qtd} foto(s)')
    if sem_aluno:
        print(f'   ⚠  {sem_aluno} foto(s) sem aluno → _sem_aluno')
    print(f'{"="*60}')
    print(f'\n   ✅ Fase 1 concluída!\n')

    # Salva índice de alunos para a Fase 2 usar
    indice = {
        nome_pasta: {
            'id':     info['id'],
            'nome':   info['nome'],
            'turma':  info['turma'],
            'ano':    info['ano'],
            'escola': info['escola'],
        }
        for nome_pasta, info in alunos_info.items()
    }
    indice_path = pasta_saida / '_indice_alunos.json'
    with open(indice_path, 'w', encoding='utf-8') as f:
        import json as _json
        _json.dump(indice, f, ensure_ascii=False, indent=2)

    print(f'   📋 Índice salvo: {indice_path.name}')
    print(f'   👉 Próximo passo: execute o 3_MONTAR_PRODUTOS.bat\n')

    return alunos_info


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        input('\nPressione Enter para fechar...')
        sys.exit(0)

    origem = Path(sys.argv[1])
    if not origem.exists():
        print(f'\n❌  Pasta não encontrada: {origem}')
        input('\nPressione Enter para fechar...')
        sys.exit(1)

    if len(sys.argv) >= 3:
        saida = Path(sys.argv[2])
    else:
        data_hoje = datetime.now().strftime('%Y-%m-%d')
        saida = origem.parent / f'Organizado_{origem.name}_{data_hoje}'

    try:
        organizar(origem, saida)
    except KeyboardInterrupt:
        print('\n\nInterrompido pelo usuário.')

    input('\nPressione Enter para fechar...')
