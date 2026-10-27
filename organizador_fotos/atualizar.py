"""Atualizador automatico do For School - Organizador de Fotos.

Roda sozinho toda vez que o programa e' aberto (ABRIR_PROGRAMA.bat / .exe) e
tambem pela aba "3 · Atualizar" da janela. Se o computador tem internet,
compara os arquivos .py desta pasta com os do repositorio publico no GitHub e
baixa os que mudaram. Sem internet, ou se algo falhar, nao quebra nada: o
programa abre normalmente com o que ja tem.

- Nunca mexe em supabase.local.env, temas_personalizados.json nem em fotos.
- So' baixa arquivos .py e LEIA-ME.txt desta pasta do repositorio.
- No computador onde a pasta e' um repositorio git (.git), nao faz nada:
  la' a atualizacao e' o "git pull".
"""
import json
import os
import sys
import urllib.request
from pathlib import Path

PASTA = Path(__file__).resolve().parent
REPO = 'playupfotografia/forschool'
CAMINHO = 'organizador_fotos'
API = f'https://api.github.com/repos/{REPO}/contents/{CAMINHO}?ref=main'
RAW = f'https://raw.githubusercontent.com/{REPO}/main/{CAMINHO}/'
MANIFESTO = PASTA / '_versao_kit.json'
TIMEOUT = 10
# Se a API do GitHub falhar (limite de consultas da rede), tenta estes direto.
ARQUIVOS_PADRAO = ['ForSchool_Fotos.py', 'organizador_fotos.py', 'montar_produtos.py',
                   'conferir_pedidos.py', 'gerar_teste.py', 'atualizar.py', 'LEIA-ME.txt']


def _get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'forschool-atualizador'})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


def _gravar(nome, conteudo):
    if nome.endswith('.py'):
        # Nao instala arquivo quebrado: se nao compila, mantem o antigo.
        compile(conteudo.decode('utf-8'), nome, 'exec')
    tmp = PASTA / (nome + '.novo')
    tmp.write_bytes(conteudo)
    os.replace(tmp, PASTA / nome)


def executar(log=print):
    """Atualiza. Devolve (lista_de_arquivos_atualizados, mensagem_de_erro_ou_None)."""
    if (PASTA / '.git').exists() or (PASTA.parent / '.git').exists():
        log('Esta pasta é um repositório git: a atualização é pelo "git pull".')
        return [], None

    try:
        manifesto = json.loads(MANIFESTO.read_text(encoding='utf-8'))
    except Exception:
        manifesto = {}

    atualizados, erros = [], []

    try:
        lista = json.loads(_get(API).decode('utf-8'))
        itens = [(i['name'], i.get('sha'), i.get('download_url')) for i in lista
                 if i.get('type') == 'file' and i.get('download_url')
                 and (i['name'].endswith('.py') or i['name'] == 'LEIA-ME.txt')]
        modo = 'api'
    except Exception as e:
        log(f'Não consegui a lista pela API do GitHub ({e}). Tentando direto...')
        itens = [(n, None, RAW + n) for n in ARQUIVOS_PADRAO]
        modo = 'raw'

    internet_ok = modo == 'api'
    for nome, sha, url in itens:
        try:
            if modo == 'api' and manifesto.get(nome) == sha and (PASTA / nome).exists():
                continue
            conteudo = _get(url)
            internet_ok = True
            atual = (PASTA / nome).read_bytes() if (PASTA / nome).exists() else None
            if modo == 'raw' and atual == conteudo:
                continue
            _gravar(nome, conteudo)
            if sha:
                manifesto[nome] = sha
            atualizados.append(nome)
            log(f'  atualizado: {nome}')
        except Exception as e:
            erros.append(f'{nome}: {e}')
            log(f'  falhou {nome}: {e}')

    if atualizados:
        try:
            MANIFESTO.write_text(json.dumps(manifesto, indent=2), encoding='utf-8')
        except Exception:
            pass
    elif internet_ok and not erros:
        # Marca que o atualizador rodou e esta' em dia.
        try:
            MANIFESTO.write_text(json.dumps(manifesto, indent=2), encoding='utf-8')
        except Exception:
            pass

    if not internet_ok:
        return atualizados, 'Sem acesso ao GitHub. Confira a internet (ou o antivírus/firewall).'
    if erros:
        return atualizados, 'Alguns arquivos falharam: ' + '; '.join(erros[:3])
    return atualizados, None


def main():
    try:
        atualizados, erro = executar(print)
        if atualizados:
            print('Atualizado: ' + ', '.join(atualizados))
    except Exception as e:
        print(f'Atualizador ignorado: {e}')


if __name__ == '__main__':
    main()
    sys.exit(0)
