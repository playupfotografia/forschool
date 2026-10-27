"""Lancador do For School - Organizador de Fotos (vira o ForSchool_Fotos.exe).

O .exe so' traz o Python e as bibliotecas (OpenCV, Pillow...). O programa em si
(ForSchool_Fotos.py) fica em arquivos .py AO LADO do .exe e e' atualizado
sozinho pela internet a cada abertura (atualizar.py) - entao uma versao nova
do programa NAO exige gerar outro .exe. So' precisa de .exe novo se mudar
alguma biblioteca.
"""
import runpy
import sys
from pathlib import Path

# So' pra o PyInstaller enxergar tudo que o programa importa (nunca executa).
if False:
    import ForSchool_Fotos          # noqa: F401
    import atualizar                # noqa: F401
    import cv2, requests, urllib3   # noqa: F401
    from PIL import Image, ImageTk, ImageOps  # noqa: F401

BASE = Path(sys.executable).parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent


def _erro(msg):
    try:
        import tkinter as tk
        from tkinter import messagebox
        r = tk.Tk(); r.withdraw()
        messagebox.showerror('For School - Organizador de Fotos', msg)
    except Exception:
        pass


def main():
    try:
        # Usa o atualizar.py da PASTA (que se atualiza sozinho); o que vem dentro
        # do .exe e' so' reserva.
        import importlib.util
        arq = BASE / 'atualizar.py'
        if arq.exists():
            spec = importlib.util.spec_from_file_location('atualizar_pasta', str(arq))
            atualizar = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(atualizar)
        else:
            import atualizar
        atualizar.PASTA = BASE
        atualizar.MANIFESTO = BASE / '_versao_kit.json'
        if hasattr(atualizar, 'executar'):
            atualizar.executar(lambda *_: None)
        else:
            atualizar.main()
    except Exception:
        pass   # sem internet: segue com o que tem

    prog = BASE / 'ForSchool_Fotos.py'
    if not prog.exists():
        _erro('Não encontrei o programa (ForSchool_Fotos.py) ao lado do .exe.\n\n'
              'É a primeira vez neste computador? Conecte à internet e abra de novo '
              'para ele baixar o programa.')
        return
    sys.path.insert(0, str(BASE))
    runpy.run_path(str(prog), run_name='__main__')


if __name__ == '__main__':
    main()
