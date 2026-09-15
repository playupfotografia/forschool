#!/usr/bin/env python3
"""
Gera fotos de teste com QR code para simular o dia da foto.
"""
import qrcode
import json
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import shutil

PASTA_TESTE = Path(__file__).parent / '_TESTE_CARTAO'
PASTA_TESTE.mkdir(exist_ok=True)

# Alunos de teste
ALUNOS = [
    {'id': 'ee63c095-9a1d-439e-9c07-6926b2580e4f', 'n': 'Antonella Cantieri',  't': 'A', 'a': '1 FUND I', 'e': 'Colegio Sena de Miranda'},
    {'id': '83db96a7-3033-42d6-bf8e-dd9208b498a6', 'n': 'teste10',              't': 'A', 'a': '2 FUND I', 'e': 'Colegio Sena de Miranda'},
    {'id': 'd972c5c6-050c-4f57-8e26-84df2aa3ed4d', 'n': 'teste5 filho',         't': 'C', 'a': '1 FUND I', 'e': 'Colegio Sena de Miranda'},
]

def gerar_qr(dados: dict) -> Image.Image:
    qr = qrcode.QRCode(box_size=10, border=2)
    qr.add_data(json.dumps(dados, ensure_ascii=False))
    qr.make(fit=True)
    return qr.make_image(fill_color='black', back_color='white').convert('RGB')

def gerar_foto_simples(nome: str, cor: tuple) -> Image.Image:
    img = Image.new('RGB', (800, 1200), color=cor)
    draw = ImageDraw.Draw(img)
    # Fundo simples com nome
    draw.rectangle([50, 50, 750, 1150], outline='white', width=4)
    draw.text((400, 600), nome[:20], fill='white', anchor='mm')
    return img

contador = 1

for aluno in ALUNOS:
    cores = [(180, 120, 80), (80, 120, 180), (80, 180, 120)]
    idx = ALUNOS.index(aluno)

    # 1. Foto da FICHA com QR code
    qr_img = gerar_qr(aluno)
    qr_img = qr_img.resize((400, 400))
    ficha = Image.new('RGB', (800, 600), (240, 240, 240))
    draw = ImageDraw.Draw(ficha)
    draw.text((400, 60), f'FICHA: {aluno["n"]}', fill='black', anchor='mm')
    draw.text((400, 110), f'{aluno["a"]} - Turma {aluno["t"]}', fill='gray', anchor='mm')
    ficha.paste(qr_img, (200, 140))
    ficha.save(PASTA_TESTE / f'DSC_{contador:04d}.jpg', quality=90)
    print(f'✓ DSC_{contador:04d}.jpg — FICHA QR: {aluno["n"]}')
    contador += 1

    # 2-4. Fotos do aluno (sem QR)
    for j in range(3):
        foto = gerar_foto_simples(aluno['n'], cores[idx])
        foto.save(PASTA_TESTE / f'DSC_{contador:04d}.jpg', quality=90)
        print(f'   DSC_{contador:04d}.jpg — foto {j+1} de {aluno["n"]}')
        contador += 1

print(f'\n✅ {contador-1} arquivos criados em: {PASTA_TESTE}')
print(f'   Use esta pasta no programa para testar!')
input('\nPressione Enter para fechar...')
