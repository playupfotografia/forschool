"""Atualizador automatico do For School - Organizador de Fotos.

Roda sozinho toda vez que o programa e' aberto (ABRIR_PROGRAMA.bat). Se o
computador tem internet, compara os arquivos .py desta pasta com os do
repositorio publico no GitHub e baixa os que mudaram. Sem internet, ou se
algo falhar, nao faz nada e o programa abre normalmente.

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
API = 'https://api.github.com/repos/playupfotografia/forschool/contents/organizador_fotos?ref=main'
MANIFESTO = PASTA / '_versao_kit.json'
TIMEOUT = 8


def _get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'forschool-atualizador'})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


def main():
    if (PASTA / '.git').exists() or (PASTA.parent / '.git').exists():
        return   # computador de desenvolvimento: usa git pull
    try:
        lista = json.loads(_get(API).decode('utf-8'))
    except Exception:
        return   # sem internet / limite da API: segue com o que tem

    try:
        manifesto = json.loads(MANIFESTO.read_text(encoding='utf-8'))
    except Exception:
        manifesto = {}

    atualizados = []
    for item in lista:
        nome = item.get('name', '')
        if item.get('type') != 'file' or not item.get('download_url'):
            continue
        if not (nome.endswith('.py') or nome == 'LEIA-ME.txt'):
            continue
        if manifesto.get(nome) == item.get('sha') and (PASTA / nome).exists():
            continue
        try:
            conteudo = _get(item['download_url'])
            if nome.endswith('.py'):
                # Nao instala arquivo quebrado: se nao compila, mantem o antigo.
                compile(conteudo.decode('utf-8'), nome, 'exec')
            tmp = PASTA / (nome + '.novo')
            tmp.write_bytes(conteudo)
            os.replace(tmp, PASTA / nome)
            manifesto[nome] = item['sha']
            atualizados.append(nome)
        except Exception as e:
            print(f'  nao consegui atualizar {nome}: {e}')

    if atualizados:
        MANIFESTO.write_text(json.dumps(manifesto, indent=2), encoding='utf-8')
        print('Atualizado: ' + ', '.join(atualizados))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:   # o programa nunca pode deixar de abrir por causa disso
        print(f'Atualizador ignorado: {e}')
    sys.exit(0)
