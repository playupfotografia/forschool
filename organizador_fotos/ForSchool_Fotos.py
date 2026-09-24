#!/usr/bin/env python3
"""
For School — Organizador de Fotos
Interface gráfica completa (sem terminal)
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox, scrolledtext
import threading
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
import cv2
import json
import os
import sys
import shutil
import requests
from pathlib import Path
from datetime import datetime

# ── Credenciais Supabase ──────────────────────────────────────────────────────
# A chave fica em supabase.local.env, ao lado deste arquivo, e NAO no codigo:
# e' a service_role, que da' acesso total ao banco, e o repositorio e' publico.
# O .gitignore cobre *.env, entao ela nunca sobe junto com o programa.
def _ler_credenciais():
    caminho = Path(__file__).parent / 'supabase.local.env'
    valores = {}
    if caminho.exists():
        for linha in caminho.read_text(encoding='utf-8').splitlines():
            linha = linha.strip()
            if not linha or linha.startswith('#') or '=' not in linha:
                continue
            chave, valor = linha.split('=', 1)
            valores[chave.strip()] = valor.strip().strip('"\'')
    return valores


_CRED = _ler_credenciais()
SUPABASE_URL = _CRED.get('SUPABASE_URL', '')
SUPABASE_KEY = _CRED.get('SUPABASE_SERVICE_KEY', '')

if not SUPABASE_URL or not SUPABASE_KEY:
    import tkinter.messagebox as _mb
    _raiz = tk.Tk(); _raiz.withdraw()
    _mb.showerror(
        'Falta o arquivo de credenciais',
        'Nao encontrei o arquivo supabase.local.env na pasta do programa.\n\n'
        'Ele guarda o endereco e a chave do banco, e fica de fora do programa\n'
        'de proposito, por seguranca.\n\n'
        'Se voce trocou de computador ou reinstalou, peca uma copia do arquivo\n'
        'ou gere uma chave nova no painel do Supabase\n'
        '(Settings > API > service_role).'
    )
    sys.exit(1)

HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
}

EXTENSOES = {'.jpg','.jpeg','.JPG','.JPEG','.png','.PNG',
             '.cr2','.CR2','.cr3','.CR3','.nef','.NEF',
             '.arw','.ARW','.orf','.ORF','.rw2','.RW2'}

COR_BG     = '#F4F6FB'
COR_AZUL   = '#4B6BFB'
COR_VERDE  = '#27AE60'
COR_LARANJA= '#E3815A'
COR_TEXTO  = '#1E293B'
COR_CINZA  = '#64748B'


# ══════════════════════════════════════════════════════════════════════════════
# Lógica de negócio
# ══════════════════════════════════════════════════════════════════════════════

def ler_qr(caminho: Path):
    img = cv2.imread(str(caminho))
    if img is None:
        return None
    detector = cv2.QRCodeDetector()
    h, w = img.shape[:2]
    for escala in [0.15, 0.30, 0.60, 1.0]:
        if escala < 1.0:
            nw = max(int(w * escala), 400)
            nh = max(int(h * escala), 300)
            proc = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
        else:
            proc = img
        dados, _, _ = detector.detectAndDecode(proc)
        if dados:
            try:
                return json.loads(dados)
            except:
                return {'n': dados.strip()}
    return None


def sanitizar(nome: str, max_len=60) -> str:
    for c in r'<>:"/\|?*':
        nome = nome.replace(c, '_')
    # strip() ANTES e DEPOIS do corte: turma com nome de professor colado
    # junto (ex: "A  Professora Bruna Daiana") faz o corte em max_len cair
    # no meio de um espaço — pasta/arquivo terminando em espaço, o Windows
    # cria escondendo o espaço, e o programa trava depois tentando escrever
    # num caminho que "pra ele" ainda tem o espaço (visto ao vivo 22/09/2026).
    return nome.strip('. ')[:max_len].strip('. ') or 'Aluno'


def supabase_get(table, params):
    r = requests.get(f'{SUPABASE_URL}/rest/v1/{table}', headers=HEADERS, params=params, timeout=10, verify=False)
    r.raise_for_status()
    return r.json()


def buscar_temas_ativos():
    """Temas de foto cadastrados no admin (ex: Natal, Pequenos Artistas).

    Cada tema e' uma sessao de foto diferente no dia — o aluno troca de roupa e
    posa de novo. Por isso o organizador precisa de UMA foto escolhida por tema,
    nao uma so' pro aluno inteiro.
    """
    temas = set()
    for tabela in ('products', 'product_variants'):
        try:
            linhas = supabase_get(tabela, {
                'select': 'photo_theme',
                'photo_theme': 'not.is.null',
            })
            for l in linhas:
                t = (l.get('photo_theme') or '').strip()
                if t:
                    temas.add(t)
        except Exception:
            pass   # sem internet o programa segue so' com a foto padrao
    return sorted(temas)


def buscar_pedido_debug(aluno_id):
    """Igual a buscar_pedido mas retorna logs de diagnóstico."""
    debug = []
    if not aluno_id:
        debug.append('⚠ aluno sem ID no QR code')
        return [], debug

    # Pedido cancelado/estornado nao gera produto. Antes pegava o 1o pedido
    # que o banco devolvesse, em qualquer ordem — com um pedido cancelado e
    # outro novo pago (o responsavel pode cancelar desde 24/09/2026), podia
    # montar os produtos do pedido errado. Vale o PAGO mais recente; sem
    # pago, o mais recente em aberto.
    orders = supabase_get('orders', {
        'student_id': f'eq.{aluno_id}',
        'payment_status': 'not.in.(cancelled,refunded)',
        'select': 'id,payment_status',
        'order': 'created_at.desc',
    })
    debug.append(f'orders encontrados: {len(orders)}')
    if not orders:
        return [], debug

    escolhido = next((o for o in orders if o.get('payment_status') == 'paid'), orders[0])
    order_id = escolhido['id']
    status   = escolhido.get('payment_status', '?')
    debug.append(f'order_id={order_id[:8]}... status={status}')

    produtos = []
    vistos   = set()

    items = supabase_get('order_items', {
        'order_id': f'eq.{order_id}',
        'select': 'quantity,product:products(id,name,photo_theme),variant:product_variants(photo_theme)',
    })
    debug.append(f'order_items: {len(items)} linha(s)')
    for it in items:
        p    = it.get('product') or {}
        v    = it.get('variant') or {}
        nome = p.get('name', '').strip()
        qty  = int(it.get('quantity') or 1)
        # Tema da variacao ganha do tema do produto (mesma regra do admin):
        # "Caneca" pode existir em versao Natal e versao Pequenos Artistas.
        tema = (v.get('photo_theme') or p.get('photo_theme') or '').strip()
        if nome and nome not in vistos:
            vistos.add(nome)
            produtos.append({'produto': nome, 'quantidade': qty, 'tema': tema})
            debug.append(f'  avulso: {nome} x{qty}' + (f' [{tema}]' if tema else ''))

    kits = supabase_get('order_kits', {
        'order_id': f'eq.{order_id}',
        'select': 'quantity,kit:school_kits(name,items:school_kit_items(quantity,product:products(id,name,photo_theme)))',
    })
    debug.append(f'order_kits: {len(kits)} linha(s)')
    for ok in kits:
        kit_qty = int(ok.get('quantity') or 1)
        kit     = ok.get('kit') or {}
        kit_nome = kit.get('name', '?')
        kit_items = kit.get('items') or []
        debug.append(f'  kit: {kit_nome} (x{kit_qty}) → {len(kit_items)} item(ns) no kit')
        for ki in kit_items:
            p        = ki.get('product') or {}
            nome     = p.get('name', '').strip()
            item_qty = int(ki.get('quantity') or 1)
            tema     = (p.get('photo_theme') or '').strip()
            if nome:
                ex    = next((x for x in produtos if x['produto'] == nome), None)
                total = item_qty * kit_qty
                if ex:
                    ex['quantidade'] += total
                else:
                    produtos.append({'produto': nome, 'quantidade': total, 'tema': tema})
                debug.append(f'    → {nome} x{total}' + (f' [{tema}]' if tema else ''))

    return produtos, debug


def buscar_pedido(aluno_id):
    if not aluno_id:
        return []
    orders = supabase_get('orders', {'student_id': f'eq.{aluno_id}', 'select': 'id'})
    if not orders:
        return []
    order_id = orders[0]['id']
    produtos = []
    vistos = set()

    items = supabase_get('order_items', {
        'order_id': f'eq.{order_id}',
        'select': 'quantity,product:products(id,name)',
    })
    for it in items:
        p = it.get('product') or {}
        nome = p.get('name','').strip()
        qty  = int(it.get('quantity') or 1)
        if nome and nome not in vistos:
            vistos.add(nome)
            produtos.append({'produto': nome, 'quantidade': qty})

    kits = supabase_get('order_kits', {
        'order_id': f'eq.{order_id}',
        'select': 'quantity,kit:school_kits(name,items:school_kit_items(quantity,product:products(id,name)))',
    })
    for ok in kits:
        kit_qty = int(ok.get('quantity') or 1)
        kit = ok.get('kit') or {}
        for ki in (kit.get('items') or []):
            p = ki.get('product') or {}
            nome = p.get('name','').strip()
            item_qty = int(ki.get('quantity') or 1)
            if nome:
                ex = next((x for x in produtos if x['produto'] == nome), None)
                total = item_qty * kit_qty
                if ex:
                    ex['quantidade'] += total
                else:
                    produtos.append({'produto': nome, 'quantidade': total})
    return produtos


# ══════════════════════════════════════════════════════════════════════════════
# Interface gráfica
# ══════════════════════════════════════════════════════════════════════════════

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('For School — Organizador de Fotos')
        self.geometry('820x640')
        self.configure(bg=COR_BG)
        self.resizable(True, True)

        self.pasta_origem   = tk.StringVar()
        self.pasta_saida    = tk.StringVar()
        self.alunos_info    = {}   # nome_pasta → info
        self.foto_vars      = {}   # nome_pasta → StringVar (foto escolhida)

        self._build_ui()

    # ── Layout ────────────────────────────────────────────────────────────────

    def _build_ui(self):
        # Header
        hdr = tk.Frame(self, bg=COR_AZUL, height=56)
        hdr.pack(fill='x')
        tk.Label(hdr, text='📸  For School — Organizador de Fotos',
                 bg=COR_AZUL, fg='white',
                 font=('Segoe UI', 14, 'bold')).pack(side='left', padx=20, pady=14)

        # Notebook (abas)
        style = ttk.Style(self)
        style.theme_use('clam')
        style.configure('TNotebook', background=COR_BG, borderwidth=0)
        style.configure('TNotebook.Tab', font=('Segoe UI', 10, 'bold'),
                        padding=[16, 8], background='#DDE3F5', foreground=COR_CINZA)
        style.map('TNotebook.Tab', background=[('selected', COR_AZUL)],
                  foreground=[('selected', 'white')])

        self.nb = ttk.Notebook(self)
        self.nb.pack(fill='both', expand=True, padx=16, pady=12)

        self.tab1 = tk.Frame(self.nb, bg=COR_BG)
        self.tab2 = tk.Frame(self.nb, bg=COR_BG)
        self.nb.add(self.tab1, text='  1 · Organizar por aluno  ')
        self.nb.add(self.tab2, text='  2 · Montar produtos  ')

        self._build_tab1()
        self._build_tab2()

    def _card(self, parent, titulo):
        frm = tk.LabelFrame(parent, text=f'  {titulo}  ',
                            bg=COR_BG, fg=COR_AZUL,
                            font=('Segoe UI', 10, 'bold'),
                            relief='groove', bd=1)
        frm.pack(fill='x', padx=8, pady=6)
        return frm

    def _btn(self, parent, texto, cmd, cor=COR_AZUL, fg='white'):
        b = tk.Button(parent, text=texto, command=cmd,
                      bg=cor, fg=fg, relief='flat',
                      font=('Segoe UI', 10, 'bold'),
                      padx=18, pady=8, cursor='hand2',
                      activebackground=COR_CINZA, activeforeground='white')
        return b

    # ── Aba 1: Organizar ──────────────────────────────────────────────────────

    def _build_tab1(self):
        p = self.tab1

        c1 = self._card(p, 'Pasta com as fotos do cartão de memória')
        row = tk.Frame(c1, bg=COR_BG)
        row.pack(fill='x', padx=10, pady=10)
        tk.Entry(row, textvariable=self.pasta_origem, font=('Segoe UI', 10),
                 relief='solid', bd=1).pack(side='left', fill='x', expand=True, ipady=6)
        self._btn(row, '📁 Escolher pasta', self._escolher_origem,
                  cor='#E8EEFF', fg=COR_AZUL).pack(side='left', padx=(8,0))

        c2 = self._card(p, 'Pasta de saída (onde salvar)')
        row2 = tk.Frame(c2, bg=COR_BG)
        row2.pack(fill='x', padx=10, pady=10)
        tk.Entry(row2, textvariable=self.pasta_saida, font=('Segoe UI', 10),
                 relief='solid', bd=1).pack(side='left', fill='x', expand=True, ipady=6)
        self._btn(row2, '📁 Escolher pasta', self._escolher_saida,
                  cor='#E8EEFF', fg=COR_AZUL).pack(side='left', padx=(8,0))
        tk.Label(c2, text='(deixe vazio para criar automaticamente ao lado da origem)',
                 bg=COR_BG, fg=COR_CINZA, font=('Segoe UI', 9)).pack(padx=10, pady=(0,8))

        self._btn(p, '▶  Organizar fotos por aluno', self._iniciar_fase1,
                  cor=COR_AZUL).pack(pady=10)

        self.log1 = scrolledtext.ScrolledText(p, height=14, font=('Consolas', 9),
                                              bg='#1E1E2E', fg='#A8D8A8',
                                              relief='flat', state='disabled')
        self.log1.pack(fill='both', expand=True, padx=8, pady=(0,8))

    def _escolher_origem(self):
        d = filedialog.askdirectory(title='Selecione a pasta com as fotos do cartão')
        if d:
            self.pasta_origem.set(d)

    def _escolher_saida(self):
        d = filedialog.askdirectory(title='Selecione a pasta de saída')
        if d:
            self.pasta_saida.set(d)

    def _log1(self, msg):
        # Chamado de dentro da thread da Fase 1 (organizar por aluno) — mexer
        # na janela direto de outra thread e' o que travava o programa do
        # nada, sem erro e sem gastar CPU (visto ao vivo em 22/09/2026). O
        # self.after(0, ...) entrega o trabalho pra thread principal, que e'
        # a unica que pode mexer com seguranca nos widgets do Tkinter.
        self.after(0, self._log1_ui, msg)

    def _log1_ui(self, msg):
        self.log1.configure(state='normal')
        self.log1.insert('end', msg + '\n')
        self.log1.see('end')
        self.log1.configure(state='disabled')

    def _iniciar_fase1(self):
        origem = self.pasta_origem.get().strip()
        if not origem:
            messagebox.showwarning('Atenção', 'Selecione a pasta com as fotos.')
            return
        origem = Path(origem)
        if not origem.exists():
            messagebox.showerror('Erro', f'Pasta não encontrada:\n{origem}')
            return

        saida_str = self.pasta_saida.get().strip()
        if saida_str:
            saida = Path(saida_str)
        else:
            data = datetime.now().strftime('%Y-%m-%d')
            saida = origem.parent / f'Organizado_{origem.name}_{data}'

        self.log1.configure(state='normal')
        self.log1.delete('1.0', 'end')
        self.log1.configure(state='disabled')

        threading.Thread(target=self._rodar_fase1, args=(origem, saida), daemon=True).start()

    def _rodar_fase1(self, origem, saida):
        saida.mkdir(parents=True, exist_ok=True)
        fotos = sorted([f for f in origem.iterdir() if f.suffix in EXTENSOES],
                       key=lambda f: f.name.lower())

        if not fotos:
            self._log1('❌  Nenhuma foto encontrada.')
            return

        self._log1(f'📂 Origem : {origem}')
        self._log1(f'📂 Saída  : {saida}')
        self._log1(f'📷 Total  : {len(fotos)} foto(s)\n')

        aluno_atual = None
        pasta_aluno = None
        fotos_aluno = 0
        alunos_info = {}
        sem_aluno   = 0
        pasta_sem   = saida / '_sem_aluno'

        turmas_info = {}   # nome_pasta -> quantas fotos de turma

        for i, foto in enumerate(fotos, 1):
          try:
            dados = ler_qr(foto)

            # QR de TURMA (cartao "foto de turma", gerado no admin). Marca o
            # inicio das fotos coletivas: elas nao pertencem a aluno nenhum, e
            # sem isso caem na pasta do ultimo aluno fotografado.
            if dados and str(dados.get('tipo', '')).lower() == 'turma':
                turma   = dados.get('turma', dados.get('t', ''))
                ano     = dados.get('ano', dados.get('a', ''))
                periodo = dados.get('periodo', dados.get('p', ''))

                if aluno_atual and aluno_atual in alunos_info:
                    alunos_info[aluno_atual]['fotos_count'] = fotos_aluno

                partes = [p for p in [ano, f'Turma {turma}' if turma else ''] if p]
                nome_pasta = sanitizar(' - '.join(partes)) or 'Turma'
                pasta_aluno = saida / '_TURMAS' / nome_pasta
                pasta_aluno.mkdir(parents=True, exist_ok=True)

                # aluno_atual = None e' o que diz ao resto do laco "as proximas
                # fotos nao sao de aluno": elas sao copiadas, mas nao entram no
                # indice nem viram produto.
                aluno_atual = None
                fotos_aluno = 0
                turmas_info.setdefault(nome_pasta, 0)
                self._log1(f'🏫 QR TURMA → {nome_pasta}' + (f'  ({periodo})' if periodo else ''))
                continue

            if dados:
                nome   = dados.get('nome', dados.get('n', 'Desconhecido'))
                turma  = dados.get('turma', dados.get('t', ''))
                escola = dados.get('escola', dados.get('e', ''))
                ano    = dados.get('ano', dados.get('a', ''))
                aluno_id = dados.get('id', '')

                if aluno_atual and aluno_atual in alunos_info:
                    alunos_info[aluno_atual]['fotos_count'] = fotos_aluno

                partes = [nome]
                if ano:   partes.append(ano)
                if turma: partes.append(f'Turma {turma}')
                nome_pasta = sanitizar(' - '.join(partes))

                aluno_atual = nome_pasta
                pasta_aluno = saida / nome_pasta
                pasta_aluno.mkdir(exist_ok=True)

                # O mesmo aluno volta varias vezes no dia: fotografa o QR dele,
                # faz o uniforme, vai trocar de roupa, entra outro aluno, e
                # depois o QR dele aparece de novo pro tema seguinte. Recriar o
                # registro aqui apagava as fotos ja' listadas — elas continuavam
                # na pasta, mas sumiam da tela de escolher a melhor foto.
                ja_visto = nome_pasta in alunos_info
                if ja_visto:
                    fotos_aluno = alunos_info[nome_pasta].get('fotos_count', 0)
                    # Cada volta do QR abre um bloco: 1 uniforme, 2 um tema, etc.
                    alunos_info[nome_pasta]['bloco_atual'] += 1
                else:
                    fotos_aluno = 0
                    alunos_info[nome_pasta] = {
                        'id': aluno_id, 'nome': nome, 'turma': turma,
                        'ano': ano, 'escola': escola,
                        'pasta': str(pasta_aluno), 'fotos': [],
                        'blocos': [],        # bloco de cada foto, na mesma ordem
                        'bloco_atual': 1,
                    }
                bloco = alunos_info[nome_pasta]['bloco_atual']
                volta = f'  (bloco {bloco})' if ja_visto else ''
                self._log1(f'📋 QR → {nome}  ({ano} Turma {turma}){volta}')

            elif pasta_aluno is not None:
                fotos_aluno += 1
                # Foto de aluno leva o nome da pasta (aluno + turma), nao o
                # nome cru da camera — sem isso nao da' pra saber de quem e'
                # a foto quando ela sai dessa pasta (ex: copiada avulsa pra
                # imprimir/mandar pra fora). Foto de turma mantem o nome
                # original, igual sempre foi.
                if aluno_atual:
                    destino = pasta_aluno / f'{aluno_atual} - {fotos_aluno:02d}{foto.suffix.lower()}'
                else:
                    destino = pasta_aluno / foto.name
                shutil.copy2(foto, destino)
                # aluno_atual None = estamos numa foto de turma: copia, mas nao
                # registra no indice (foto de turma nao vira produto de aluno).
                if aluno_atual and aluno_atual in alunos_info:
                    # Foto repetida (mesmo cartao lido duas vezes) nao entra de novo
                    if str(destino) not in alunos_info[aluno_atual]['fotos']:
                        alunos_info[aluno_atual]['fotos'].append(str(destino))
                        alunos_info[aluno_atual]['blocos'].append(
                            alunos_info[aluno_atual]['bloco_atual'])
                else:
                    turmas_info[pasta_aluno.name] = turmas_info.get(pasta_aluno.name, 0) + 1
                self._log1(f'   ✓ {destino.name}')

            else:
                sem_aluno += 1
                pasta_sem.mkdir(exist_ok=True)
                shutil.copy2(foto, pasta_sem / foto.name)
                self._log1(f'   ⚠ {foto.name} → _sem_aluno')
          except Exception as e:
            # Antes, qualquer erro aqui matava a thread em silencio (pythonw
            # nao tem console pra mostrar o traceback) — o programa parava
            # de escrever no log e ficava ali pra sempre, parecendo travado,
            # sem nenhum aviso. Agora aparece na tela e ele segue pra
            # proxima foto em vez de morrer. Visto ao vivo em 22/09/2026.
            self._log1(f'❌ ERRO em {foto.name}: {e} — pulando essa foto')

        if aluno_atual and aluno_atual in alunos_info:
            alunos_info[aluno_atual]['fotos_count'] = fotos_aluno

        # Salva índice
        indice_path = saida / '_indice_alunos.json'
        with open(indice_path, 'w', encoding='utf-8') as f:
            json.dump(alunos_info, f, ensure_ascii=False, indent=2)

        self.alunos_info = alunos_info
        self._pasta_organizada = saida

        self._log1(f'\n✅ Concluído! {len(alunos_info)} aluno(s) organizados.')
        if turmas_info:
            total_turma = sum(turmas_info.values())
            self._log1(f'🏫 {total_turma} foto(s) de turma → _TURMAS/')
            for nome_t, qtd in turmas_info.items():
                self._log1(f'     {nome_t}: {qtd} foto(s)')
        if sem_aluno:
            self._log1(f'⚠  {sem_aluno} foto(s) sem aluno → _sem_aluno')
        self._log1(f'\n👉 Vá para a aba "2 · Montar produtos" para continuar.')

        # Pré-carrega aba 2
        self.after(0, self._carregar_aba2, saida, alunos_info)

    # ── Aba 2: Montar produtos ────────────────────────────────────────────────

    def _build_tab2(self):
        p = self.tab2

        # Botão para abrir pasta já organizada
        topo = tk.Frame(p, bg=COR_BG)
        topo.pack(fill='x', padx=8, pady=8)
        self._btn(topo, '📁 Abrir pasta já organizada', self._abrir_organizada,
                  cor='#E8EEFF', fg=COR_AZUL).pack(side='left')
        tk.Label(topo, text='(se já rodou o Passo 1 antes)',
                 bg=COR_BG, fg=COR_CINZA, font=('Segoe UI', 9)).pack(side='left', padx=10)

        # Frame rolável de alunos
        self.frame_alunos_outer = tk.Frame(p, bg=COR_BG)
        self.frame_alunos_outer.pack(fill='both', expand=True, padx=8)

        self.canvas_alunos = tk.Canvas(self.frame_alunos_outer, bg=COR_BG,
                                       highlightthickness=0)
        scrollbar = ttk.Scrollbar(self.frame_alunos_outer, orient='vertical',
                                  command=self.canvas_alunos.yview)
        self.frame_alunos = tk.Frame(self.canvas_alunos, bg=COR_BG)
        self.frame_alunos.bind('<Configure>',
            lambda e: self.canvas_alunos.configure(
                scrollregion=self.canvas_alunos.bbox('all')))
        self.canvas_alunos.create_window((0,0), window=self.frame_alunos, anchor='nw')
        self.canvas_alunos.configure(yscrollcommand=scrollbar.set)
        self.canvas_alunos.pack(side='left', fill='both', expand=True)
        scrollbar.pack(side='right', fill='y')

        # Bind scroll do mouse
        self.canvas_alunos.bind_all('<MouseWheel>',
            lambda e: self.canvas_alunos.yview_scroll(int(-1*(e.delta/120)), 'units'))

        tk.Label(self.frame_alunos,
                 text='Execute o Passo 1 ou abra uma pasta já organizada.',
                 bg=COR_BG, fg=COR_CINZA, font=('Segoe UI', 10)).pack(pady=30)

        # Botão salvar
        rodape = tk.Frame(p, bg=COR_BG)
        rodape.pack(fill='x', padx=8, pady=8)
        self._btn(rodape, '✅  Montar e salvar tudo', self._montar_tudo,
                  cor=COR_VERDE).pack(side='right')

        self.log2 = scrolledtext.ScrolledText(p, height=6, font=('Consolas', 9),
                                              bg='#1E1E2E', fg='#A8D8A8',
                                              relief='flat', state='disabled')
        self.log2.pack(fill='x', padx=8, pady=(0,4))

    def _log2(self, msg):
        # Mesmo motivo do _log1: chamado de dentro da thread da Fase 2, tem
        # que passar pela thread principal via self.after (ver _log1).
        self.after(0, self._log2_ui, msg)

    def _log2_ui(self, msg):
        self.log2.configure(state='normal')
        self.log2.insert('end', msg + '\n')
        self.log2.see('end')
        self.log2.configure(state='disabled')

    def _abrir_organizada(self):
        d = filedialog.askdirectory(title='Selecione a pasta organizada (resultado do Passo 1)')
        if not d:
            return
        pasta = Path(d)
        indice_path = pasta / '_indice_alunos.json'
        if not indice_path.exists():
            messagebox.showerror('Erro',
                'Esta pasta não tem o arquivo _indice_alunos.json.\n'
                'Selecione a pasta gerada pelo Passo 1.')
            return
        with open(indice_path, encoding='utf-8') as f:
            alunos_info = json.load(f)
        # O indice guarda caminho completo (ex: D:\DCIM\...). Se a pasta foi
        # movida (tirada do cartao pro HD), esses caminhos apontam pro nada.
        # A estrutura e' sempre <pasta>/<aluno>/<foto>, entao recalcula a
        # partir da pasta que foi aberta agora. Visto ao vivo em 23/09/2026.
        for nome_pasta, info in alunos_info.items():
            nova = pasta / nome_pasta
            info['pasta'] = str(nova)
            info['fotos'] = [str(nova / Path(f).name) for f in info.get('fotos', [])]
        self.alunos_info = alunos_info
        self._pasta_organizada = pasta
        self._carregar_aba2(pasta, alunos_info)
        self.nb.select(1)

    def _carregar_aba2(self, pasta_saida, alunos_info):
        # Limpa frame
        for w in self.frame_alunos.winfo_children():
            w.destroy()
        self.foto_vars = {}
        self._linhas_pendentes = set()

        # Escolhas ficam gravadas na propria pasta: fechar o programa (ou ele
        # travar) antes de "Montar e salvar tudo" nao perde horas de escolha.
        self._escolhas_salvas = {}
        arq = Path(pasta_saida) / '_escolhas.json'
        if arq.exists():
            try:
                with open(arq, encoding='utf-8') as f:
                    self._escolhas_salvas = json.load(f)
            except Exception:
                self._escolhas_salvas = {}

        if not alunos_info:
            tk.Label(self.frame_alunos, text='Nenhum aluno encontrado.',
                     bg=COR_BG, fg=COR_CINZA, font=('Segoe UI', 10)).pack(pady=20)
            return

        # Cada tema e' uma troca de roupa: o aluno posa de uniforme, depois de
        # Natal, depois de Pequeno Artista. Uma foto escolhida so' nao serve —
        # o produto de Natal precisa da foto de Natal.
        self.temas = buscar_temas_ativos()

        texto = 'Selecione a melhor foto de cada aluno:' if not self.temas \
            else 'Selecione a melhor foto de cada aluno, por tema:'
        tk.Label(self.frame_alunos, text=texto,
                 bg=COR_BG, fg=COR_TEXTO, font=('Segoe UI', 10, 'bold')).pack(
                 anchor='w', padx=10, pady=(10,4))

        if self.temas:
            tk.Label(self.frame_alunos,
                     text='Uniforme é a foto padrão — vale pra todo produto sem tema.',
                     bg=COR_BG, fg=COR_CINZA, font=('Segoe UI', 9)).pack(
                     anchor='w', padx=10, pady=(0,6))

        for nome_pasta, info in sorted(alunos_info.items()):
            fotos = info.get('fotos', [])
            self._linha_aluno(nome_pasta, info, fotos)

    def _linha_aluno(self, nome_pasta, info, fotos):
        frm = tk.Frame(self.frame_alunos, bg='white', relief='flat', bd=0)
        frm.pack(fill='x', padx=10, pady=3)
        frm.configure(highlightbackground='#E2E8F0', highlightthickness=1)

        nome = info.get('nome', nome_pasta)
        cab = tk.Frame(frm, bg='white')
        cab.pack(fill='x', padx=12, pady=(9,2))
        tk.Label(cab, text=nome, bg='white', fg=COR_TEXTO,
                 font=('Segoe UI', 10, 'bold'), anchor='w').pack(side='left')

        if not fotos:
            tk.Label(cab, text='  (sem fotos)', bg='white', fg=COR_CINZA,
                     font=('Segoe UI', 9, 'italic')).pack(side='left')
            return

        blocos = info.get('blocos', [])
        n_blocos = len(set(blocos)) if blocos else 1
        resumo = f'{len(fotos)} foto(s)' + (f' · {n_blocos} blocos' if n_blocos > 1 else '')
        tk.Label(cab, text=resumo, bg='white',
                 fg=COR_CINZA, font=('Segoe UI', 9)).pack(side='right')

        # '' = foto padrao (uniforme); depois um seletor por tema cadastrado
        self.foto_vars[nome_pasta] = {}
        for tema in [''] + list(getattr(self, 'temas', [])):
            self._linha_tema(frm, nome_pasta, fotos, tema, blocos)

        tk.Frame(frm, bg='white', height=6).pack()

    def _linha_tema(self, frm, nome_pasta, fotos, tema, blocos=None):
        rot = 'Uniforme' if tema == '' else tema
        linha = tk.Frame(frm, bg='white')
        linha.pack(fill='x', padx=12, pady=1)

        tk.Label(linha, text=rot, bg='white', fg=COR_TEXTO,
                 font=('Segoe UI', 9), width=20, anchor='w').pack(side='left')

        nomes_fotos = [Path(f).name for f in fotos]
        salvas = self._escolhas_salvas.setdefault(nome_pasta, {})
        ja_escolhida = salvas.get(tema) if salvas.get(tema) in nomes_fotos else None
        var = tk.StringVar(value=ja_escolhida or nomes_fotos[0])
        self.foto_vars[nome_pasta][tema] = (var, fotos)

        # O nome do arquivo comeca com o nome do aluno (igual em todas), entao
        # mostrar o nome cortado deixava todas as fotos com a mesma cara. Mostra
        # so' o numero da foto, e deixa claro o que ainda nao foi escolhido.
        lbl = tk.Label(linha, text='', bg='white', font=('Segoe UI', 9, 'bold'),
                       width=26, anchor='w')
        lbl.pack(side='left', padx=6)

        def atualizar_rotulo():
            nome_arq = var.get()
            if tema in salvas and salvas[tema] == nome_arq:
                num = Path(nome_arq).stem.rsplit(' - ', 1)[-1]
                txt = f'✅ Foto {num}'
                if blocos and nome_arq in nomes_fotos and len(blocos) == len(nomes_fotos):
                    txt += f'  (bloco {blocos[nomes_fotos.index(nome_arq)]})'
                lbl.config(text=txt, fg=COR_VERDE)
            else:
                lbl.config(text='— ainda não escolhida', fg=COR_CINZA)

        def ao_escolher(*_):
            salvas[tema] = var.get()
            atualizar_rotulo()
            self._salvar_escolhas()

        atualizar_rotulo()
        var.trace_add('write', ao_escolher)

        def abrir_visor(np=nome_pasta, v=var, fl=fotos, t=rot, bl=blocos):
            self._abrir_visor(np, v, fl, t, bl)
        tk.Button(linha, text='🔍 Escolher', command=abrir_visor,
                  bg=COR_AZUL, fg='white', relief='flat',
                  font=('Segoe UI', 9, 'bold'), padx=10, pady=2,
                  cursor='hand2').pack(side='right')

    def _salvar_escolhas(self):
        pasta = getattr(self, '_pasta_organizada', None)
        if not pasta:
            return
        try:
            with open(Path(pasta) / '_escolhas.json', 'w', encoding='utf-8') as f:
                json.dump(self._escolhas_salvas, f, ensure_ascii=False, indent=2)
        except Exception as e:
            messagebox.showwarning('Aviso', f'Não consegui salvar a escolha no disco:\n{e}')

    def _abrir_visor(self, nome_pasta, var, fotos, tema='', blocos=None):
        """Abre janela de visualização de fotos com navegação por teclado.

        `blocos` diz a que bloco cada foto pertence (1 = uniforme, 2 = tema
        seguinte...). Serve pra pular direto pro trecho certo em vez de
        navegar foto a foto procurando onde a roupa mudou.
        """
        from PIL import Image, ImageTk

        win = tk.Toplevel(self)
        win.title('Escolher foto')
        win.configure(bg='#1a1a2e')
        win.geometry('900x700')
        win.grab_set()  # modal

        idx = [0]  # índice atual (lista para ser mutável no closure)
        # Tenta começar na foto já selecionada
        nome_atual = var.get()
        nomes = [Path(f).name for f in fotos]
        if nome_atual in nomes:
            idx[0] = nomes.index(nome_atual)

        # ── Layout ────────────────────────────────────────────────────────────
        # Topo: nome do aluno
        info_al = self.alunos_info.get(nome_pasta, {})
        nome_al = info_al.get('nome', nome_pasta)
        titulo  = f'{nome_al}  —  {tema}' if tema else nome_al
        tk.Label(win, text=titulo, bg='#1a1a2e', fg='white',
                 font=('Segoe UI', 13, 'bold')).pack(pady=(14,2))

        lbl_contador = tk.Label(win, text='', bg='#1a1a2e', fg='#8888aa',
                                font=('Segoe UI', 10))
        lbl_contador.pack()

        # Canvas da foto
        canvas = tk.Canvas(win, bg='#1a1a2e', highlightthickness=0)
        canvas.pack(fill='both', expand=True, padx=20, pady=10)

        # Botões de navegação + escolher
        rodape = tk.Frame(win, bg='#1a1a2e')
        rodape.pack(fill='x', padx=20, pady=(0,14))

        btn_ant = tk.Button(rodape, text='◀  Anterior', font=('Segoe UI', 10, 'bold'),
                            bg='#2d2d4e', fg='white', relief='flat',
                            padx=16, pady=8, cursor='hand2')
        btn_ant.pack(side='left')

        btn_prox = tk.Button(rodape, text='Próxima  ▶', font=('Segoe UI', 10, 'bold'),
                             bg='#2d2d4e', fg='white', relief='flat',
                             padx=16, pady=8, cursor='hand2')
        btn_prox.pack(side='left', padx=8)

        # Pulo entre blocos — so' aparece quando o aluno tem mais de um
        blocos_lista = list(blocos or [])
        tem_blocos = len(set(blocos_lista)) > 1 and len(blocos_lista) == len(fotos)
        if tem_blocos:
            inicios = {}          # bloco -> indice da 1a foto dele
            for i, b in enumerate(blocos_lista):
                inicios.setdefault(b, i)
            ordem_blocos = sorted(inicios)

            def pular(passo):
                atual = blocos_lista[idx[0]]
                pos   = ordem_blocos.index(atual)
                novo  = ordem_blocos[(pos + passo) % len(ordem_blocos)]
                mostrar(inicios[novo])

            tk.Button(rodape, text='⏮ Bloco', font=('Segoe UI', 10, 'bold'),
                      bg='#3a3a5e', fg='white', relief='flat', padx=12, pady=8,
                      cursor='hand2', command=lambda: pular(-1)).pack(side='left', padx=(16,4))
            tk.Button(rodape, text='Bloco ⏭', font=('Segoe UI', 10, 'bold'),
                      bg='#3a3a5e', fg='white', relief='flat', padx=12, pady=8,
                      cursor='hand2', command=lambda: pular(1)).pack(side='left')

        dica = '← → navegar  •  Espaço escolher' + ('  •  PgUp/PgDn troca de bloco' if tem_blocos else '')
        tk.Label(rodape, text=dica,
                 bg='#1a1a2e', fg='#666688', font=('Segoe UI', 9)).pack(side='left', padx=16)

        btn_escolher = tk.Button(rodape, text='✅  Escolher esta foto  [Espaço]',
                                 font=('Segoe UI', 11, 'bold'),
                                 bg=COR_VERDE, fg='white', relief='flat',
                                 padx=20, pady=8, cursor='hand2')
        btn_escolher.pack(side='right')

        # Caso real: esqueceu de trocar o QR antes de fotografar o proximo
        # aluno, e a foto foi parar na pasta errada. Em vez de sair do
        # programa e mexer nos arquivos na mao, resolve aqui: escolhe o
        # aluno certo (com busca) e o programa move + renomeia sozinho.
        btn_mover = tk.Button(rodape, text='➡ Mover p/ outro aluno',
                              font=('Segoe UI', 10, 'bold'),
                              bg='#7C3AED', fg='white', relief='flat',
                              padx=14, pady=8, cursor='hand2')
        btn_mover.pack(side='right', padx=(0,10))

        # ── Lógica ────────────────────────────────────────────────────────────
        img_tk_ref = [None]  # mantém referência para não ser coletado pelo GC

        def mostrar(i, tentativa=0):
            idx[0] = i % len(fotos)
            path = Path(fotos[idx[0]])
            txt = f'{idx[0]+1} / {len(fotos)}  —  {path.name}'
            if len(blocos_lista) == len(fotos) and blocos_lista:
                b = blocos_lista[idx[0]]
                txt += f'   •   Bloco {b} de {max(blocos_lista)}'
            lbl_contador.config(text=txt)

            # Carrega e redimensiona a imagem
            try:
                img = Image.open(path)
                # Respeita rotação EXIF (fotos de câmera/celular)
                try:
                    from PIL import ImageOps
                    img = ImageOps.exif_transpose(img)
                except Exception:
                    pass
                img.thumbnail((860, 560), Image.LANCZOS)
                photo = ImageTk.PhotoImage(img)
                img_tk_ref[0] = photo
                canvas.delete('all')
                cw = canvas.winfo_width() or 860
                ch = canvas.winfo_height() or 560
                canvas.create_image(cw//2, ch//2, anchor='center', image=photo)
            except Exception as e:
                # A foto pode ter acabado de ser copiada pela Fase 1 (que roda
                # numa thread separada e pode ainda estar em andamento — nada
                # trava a Aba 2 enquanto isso) ou o Windows/antivirus segurou o
                # arquivo por uma fração de segundo logo depois de criado.
                # Tenta de novo antes de desistir, em vez de mostrar erro numa
                # foto que na verdade existe. Visto ao vivo em 22/09/2026.
                if tentativa < 5:
                    canvas.delete('all')
                    cw = canvas.winfo_width() or 860
                    ch = canvas.winfo_height() or 560
                    canvas.create_text(cw//2, ch//2, text='Carregando…',
                                       fill='#8888aa', font=('Segoe UI', 12))
                    win.after(400, lambda: mostrar(i, tentativa + 1))
                    return
                canvas.delete('all')
                cw = canvas.winfo_width() or 860
                ch = canvas.winfo_height() or 560
                canvas.create_text(cw//2, ch//2,
                                   text=f'Não consegui abrir esta foto:\n{path.name}\n\n{e}\n\nClique aqui pra tentar de novo',
                                   fill='red', font=('Segoe UI', 12), justify='center', width=cw-60)
                canvas.tag_bind('all', '<Button-1>', lambda e: mostrar(i, 0))
                canvas.bind('<Button-1>', lambda e: mostrar(i, 0))

        def escolher():
            var.set(Path(fotos[idx[0]]).name)
            win.destroy()

        def anterior():
            mostrar(idx[0] - 1)

        def proximo():
            mostrar(idx[0] + 1)

        def mover_para_outro():
            destino_key = self._escolher_aluno_destino(excluir=nome_pasta)
            if not destino_key:
                return

            pos = idx[0]
            origem_path = Path(fotos[pos])
            origem_info  = self.alunos_info[nome_pasta]
            destino_info = self.alunos_info[destino_key]
            destino_pasta = Path(destino_info['pasta'])
            destino_pasta.mkdir(exist_ok=True)

            # Acha o proximo numero livre olhando os arquivos que ja' estao
            # la' — nunca confia em len(fotos) sozinho, pra nao sobrescrever
            # foto de quem ja' esta' na pasta se algum numero tiver pulado.
            numeros = []
            for f in destino_pasta.glob(f'{destino_key} - *'):
                try:
                    numeros.append(int(f.stem.rsplit(' - ', 1)[-1]))
                except ValueError:
                    pass
            novo_num = (max(numeros) + 1) if numeros else 1
            novo_caminho = destino_pasta / f'{destino_key} - {novo_num:02d}{origem_path.suffix.lower()}'

            try:
                shutil.move(str(origem_path), str(novo_caminho))
            except Exception as e:
                messagebox.showerror('Erro ao mover', str(e))
                return

            # Mantem o bloco (volta do QR) de onde a foto veio: a foto de outra
            # crianca no meio do bloco de Natal do aluno errado tambem e' de
            # Natal. Antes cada foto movida virava um bloco novo.
            bloco_origem = (origem_info['blocos'][pos]
                            if pos < len(origem_info['blocos']) else 1)

            # Tira do aluno errado. `fotos` aqui e' o mesmo objeto de
            # origem_info['fotos'] (mesma lista, nao copia), entao o pop
            # ja' atualiza os dois ao mesmo tempo.
            fotos.pop(pos)
            if pos < len(origem_info['blocos']):
                origem_info['blocos'].pop(pos)
            if pos < len(blocos_lista):
                blocos_lista.pop(pos)

            # Poe no aluno certo
            destino_info['fotos'].append(str(novo_caminho))
            destino_info['blocos'].append(bloco_origem)

            # Aluno criado agora (QR nao lido): ganha a linha na Aba 2 assim
            # que tem a 1a foto. As proximas entram na mesma lista (mesmo
            # objeto), entao a linha nao precisa ser redesenhada.
            if destino_key in self._linhas_pendentes:
                self._linhas_pendentes.discard(destino_key)
                self._linha_aluno(destino_key, destino_info, destino_info['fotos'])
            # Sem isso, reabrir a pasta depois traria a foto de volta no aluno
            # errado (apontando pra um arquivo que ja' saiu de la').
            try:
                pasta_org = getattr(self, '_pasta_organizada', None)
                if pasta_org:
                    with open(Path(pasta_org) / '_indice_alunos.json', 'w', encoding='utf-8') as f:
                        json.dump(self.alunos_info, f, ensure_ascii=False, indent=2)
            except Exception as e:
                messagebox.showwarning('Aviso',
                    f'A foto foi movida, mas não consegui atualizar o índice:\n{e}')

            # Aviso no titulo em vez de janela: mover 10+ fotos de uma crianca
            # com um "OK" pra clicar a cada uma cansa.
            win.title(f'Escolher foto   —   ✓ movida pra {destino_info.get("nome", destino_key)}')

            if not fotos:
                win.destroy()
            else:
                mostrar(pos % len(fotos))

        btn_ant.config(command=anterior)
        btn_prox.config(command=proximo)
        btn_escolher.config(command=escolher)
        btn_mover.config(command=mover_para_outro)

        def tecla(e):
            if e.keysym == 'Left':   anterior()
            elif e.keysym == 'Right': proximo()
            elif e.keysym == 'space': escolher()
            elif e.keysym == 'Escape': win.destroy()
            elif e.keysym == 'Prior' and tem_blocos: pular(-1)   # PgUp
            elif e.keysym == 'Next'  and tem_blocos: pular(1)    # PgDn

        win.bind('<Key>', tecla)
        win.focus_set()

        # Redimensiona canvas quando janela muda
        def on_resize(e):
            mostrar(idx[0])
        canvas.bind('<Configure>', on_resize)

        # Mostra primeira foto
        win.after(100, lambda: mostrar(idx[0]))

    def _escolher_aluno_destino(self, excluir):
        """Janela pequena com busca pra escolher pra qual aluno uma foto
        (que foi parar na pasta errada) deveria ter ido. Devolve a chave
        (nome_pasta) escolhida, ou None se cancelou.
        """
        picker = tk.Toplevel(self)
        picker.title('Mover foto para...')
        picker.configure(bg=COR_BG)
        picker.geometry('420x480')
        picker.transient(self)
        picker.grab_set()

        tk.Label(picker, text='Pra qual aluno essa foto é de verdade?',
                 bg=COR_BG, fg=COR_TEXTO, font=('Segoe UI', 10, 'bold')).pack(
                 pady=(14,6), padx=14, anchor='w')

        busca_var = tk.StringVar()
        entry = tk.Entry(picker, textvariable=busca_var, font=('Segoe UI', 10))
        entry.pack(fill='x', padx=14, pady=(0,8))
        entry.focus_set()

        lista = tk.Listbox(picker, font=('Segoe UI', 10), activestyle='dotbox')
        lista.pack(fill='both', expand=True, padx=14, pady=(0,10))
        lista._chaves = []

        opcoes = sorted(
            [(k, v.get('nome', k), v.get('turma', '')) for k, v in self.alunos_info.items()
             if k != excluir],
            key=lambda t: t[1]
        )

        def atualizar_lista(*_a):
            termo = busca_var.get().strip().lower()
            lista.delete(0, 'end')
            chaves = []
            for k, nome, turma in opcoes:
                if termo and termo not in nome.lower():
                    continue
                texto = f'{nome}  ({turma})' if turma else nome
                lista.insert('end', texto)
                chaves.append(k)
            lista._chaves = chaves
            if chaves:
                lista.selection_set(0)

        atualizar_lista()
        busca_var.trace_add('write', atualizar_lista)

        resultado = [None]

        def confirmar(event=None):
            sel = lista.curselection()
            if not sel:
                return
            resultado[0] = lista._chaves[sel[0]]
            picker.destroy()

        entry.bind('<Return>', confirmar)
        entry.bind('<Down>', lambda e: lista.focus_set())
        lista.bind('<Return>', confirmar)
        lista.bind('<Double-Button-1>', confirmar)
        picker.bind('<Escape>', lambda e: picker.destroy())

        tk.Label(picker, text='Só aparecem alunos que já têm pasta. Não achou?\n'
                              'Clique em "➕ Aluno sem pasta" pra buscar no cadastro.',
                 bg=COR_BG, fg=COR_LARANJA, font=('Segoe UI', 9), justify='left').pack(
                 anchor='w', padx=14, pady=(0,6), before=lista)

        botoes = tk.Frame(picker, bg=COR_BG)
        botoes.pack(fill='x', padx=14, pady=(0,14))
        tk.Button(botoes, text='Cancelar', command=picker.destroy,
                  bg='#E2E8F0', relief='flat', padx=14, pady=6,
                  cursor='hand2').pack(side='left')
        tk.Button(botoes, text='Mover pra cá', command=confirmar,
                  bg=COR_VERDE, fg='white', relief='flat', padx=14, pady=6,
                  cursor='hand2').pack(side='right')

        # Caso real (23/09/2026): a ficha da Antonella foi fotografada mas o QR
        # nao foi lido — ela nao ganhou pasta, e as fotos dela cairam na do
        # aluno anterior. Sem isso nao havia pra onde mover.
        def criar_novo():
            k = self._criar_aluno_novo(picker, busca_var.get().strip())
            if k:
                resultado[0] = k
                picker.destroy()
        tk.Button(botoes, text='➕ Aluno sem pasta', command=criar_novo,
                  bg='#E8EEFF', fg=COR_AZUL, relief='flat', padx=10, pady=6,
                  cursor='hand2').pack(side='left', padx=8)

        self.wait_window(picker)
        return resultado[0]

    def _criar_aluno_novo(self, parent, termo_inicial=''):
        """Cria pasta + registro pra um aluno cujo QR nao foi lido na Fase 1.
        Busca no cadastro de preferencia: com o id certo, a montagem acha o
        pedido dele; digitado a mao, sai como "so' autorizou"."""
        dlg = tk.Toplevel(parent)
        dlg.title('Criar pasta de aluno')
        dlg.configure(bg=COR_BG)
        dlg.geometry('480x560')
        dlg.transient(parent)
        dlg.grab_set()

        tk.Label(dlg, text='Aluno que ficou sem pasta (o QR da ficha não foi lido)',
                 bg=COR_BG, fg=COR_TEXTO, font=('Segoe UI', 10, 'bold')).pack(
                 anchor='w', padx=14, pady=(14,2))
        tk.Label(dlg, text='1) Busque pelo nome no cadastro — assim o programa acha o pedido.',
                 bg=COR_BG, fg=COR_CINZA, font=('Segoe UI', 9)).pack(anchor='w', padx=14)

        linha_b = tk.Frame(dlg, bg=COR_BG)
        linha_b.pack(fill='x', padx=14, pady=(6,4))
        busca = tk.Entry(linha_b, font=('Segoe UI', 10))
        busca.pack(side='left', fill='x', expand=True)
        busca.focus_set()

        lista = tk.Listbox(dlg, font=('Segoe UI', 10), height=7)
        lista.pack(fill='x', padx=14)
        achados = []
        aluno_id = ['']

        tk.Label(dlg, text='2) Confira (ou preencha à mão se não achar):',
                 bg=COR_BG, fg=COR_CINZA, font=('Segoe UI', 9)).pack(anchor='w', padx=14, pady=(10,2))
        campos = {}
        for rot in ('Nome', 'Série/Ano', 'Turma'):
            f = tk.Frame(dlg, bg=COR_BG)
            f.pack(fill='x', padx=14, pady=2)
            tk.Label(f, text=rot, bg=COR_BG, fg=COR_TEXTO, width=10, anchor='w',
                     font=('Segoe UI', 9)).pack(side='left')
            e = tk.Entry(f, font=('Segoe UI', 10))
            e.pack(side='left', fill='x', expand=True)
            campos[rot] = e

        lbl_cad = tk.Label(dlg, text='', bg=COR_BG, font=('Segoe UI', 9))
        lbl_cad.pack(anchor='w', padx=14, pady=(4,0))

        def buscar(event=None):
            termo = busca.get().strip()
            if len(termo) < 3:
                messagebox.showinfo('Busca', 'Digite pelo menos 3 letras do nome.', parent=dlg)
                return
            try:
                rows = supabase_get('students', {
                    'select': 'id,name,class:school_classes(name,year:school_years(name))',
                    'name': f'ilike.*{termo}*', 'order': 'name', 'limit': '30'})
            except Exception as e:
                messagebox.showerror('Busca', f'Não consegui buscar no cadastro (internet?):\n{e}', parent=dlg)
                return
            lista.delete(0, 'end')
            achados.clear()
            for r in rows:
                cl = r.get('class') or {}
                ano = (cl.get('year') or {}).get('name', '')
                turma = cl.get('name', '')
                achados.append((r['id'], r['name'], ano, turma))
                lista.insert('end', f"{r['name']}  —  {ano}  —  Turma {turma}")
            if not rows:
                lista.insert('end', '(ninguém com esse nome no cadastro)')

        def selecionar(event=None):
            sel = lista.curselection()
            if not sel or sel[0] >= len(achados):
                return
            i, nome, ano, turma = achados[sel[0]]
            for rot, val in (('Nome', nome), ('Série/Ano', ano), ('Turma', turma)):
                campos[rot].delete(0, 'end')
                campos[rot].insert(0, val)
            aluno_id[0] = i
            lbl_cad.config(text='✓ Ligado ao cadastro — o pedido vai ser encontrado na montagem.',
                           fg=COR_VERDE)

        def digitou(event=None):
            # mexeu no nome a mao: deixa de ser o aluno do cadastro
            if aluno_id[0]:
                aluno_id[0] = ''
                lbl_cad.config(text='⚠ Preenchido à mão — sem ligação com o cadastro, sai como "só autorizou".',
                               fg=COR_LARANJA)

        tk.Button(linha_b, text='🔍 Buscar', command=buscar, bg=COR_AZUL, fg='white',
                  relief='flat', padx=10, cursor='hand2').pack(side='left', padx=(6,0))
        busca.bind('<Return>', buscar)
        lista.bind('<<ListboxSelect>>', selecionar)
        campos['Nome'].bind('<Key>', digitou)

        # O que ja' foi digitado na janela anterior vira a busca, sem redigitar
        if termo_inicial:
            busca.insert(0, termo_inicial)
            if len(termo_inicial) >= 3:
                dlg.after(50, buscar)

        resultado = [None]

        def criar():
            nome  = campos['Nome'].get().strip()
            ano   = campos['Série/Ano'].get().strip()
            turma = campos['Turma'].get().strip()
            if not nome:
                messagebox.showwarning('Falta o nome', 'Preencha pelo menos o nome.', parent=dlg)
                return
            # Mesmo formato da Fase 1, pra pasta ficar igual se o QR tivesse lido
            partes = [nome] + ([ano] if ano else []) + ([f'Turma {turma}'] if turma else [])
            chave = sanitizar(' - '.join(partes))
            if chave in self.alunos_info:
                messagebox.showinfo('Já existe', 'Esse aluno já tem pasta — a foto vai pra ela.', parent=dlg)
                resultado[0] = chave
                dlg.destroy()
                return
            pasta = Path(self._pasta_organizada) / chave
            try:
                pasta.mkdir(exist_ok=True)
            except Exception as e:
                messagebox.showerror('Erro', f'Não consegui criar a pasta:\n{e}', parent=dlg)
                return
            self.alunos_info[chave] = {
                'id': aluno_id[0], 'nome': nome, 'turma': turma, 'ano': ano,
                'escola': '', 'pasta': str(pasta), 'fotos': [], 'blocos': [],
                'bloco_atual': 1,
            }
            # A linha dela na Aba 2 so' e' desenhada depois da 1a foto chegar
            # (linha sem foto nao tem botao de escolher).
            self._linhas_pendentes.add(chave)
            resultado[0] = chave
            dlg.destroy()

        rod = tk.Frame(dlg, bg=COR_BG)
        rod.pack(fill='x', side='bottom', padx=14, pady=14)
        tk.Button(rod, text='Cancelar', command=dlg.destroy, bg='#E2E8F0',
                  relief='flat', padx=14, pady=6, cursor='hand2').pack(side='left')
        tk.Button(rod, text='Criar pasta e mover a foto', command=criar, bg=COR_VERDE,
                  fg='white', relief='flat', padx=14, pady=6, cursor='hand2').pack(side='right')

        dlg.bind('<Escape>', lambda e: dlg.destroy())
        self.wait_window(dlg)
        return resultado[0]

    def _montar_tudo(self):
        if not self.alunos_info:
            messagebox.showwarning('Atenção', 'Execute o Passo 1 primeiro ou abra uma pasta organizada.')
            return
        threading.Thread(target=self._rodar_fase2, daemon=True).start()

    def _rodar_fase2(self):
        pasta_saida = self._pasta_organizada
        pasta_prod  = pasta_saida / '_PRODUTOS'
        pasta_prod.mkdir(exist_ok=True)

        self.log2.configure(state='normal')
        self.log2.delete('1.0', 'end')
        self.log2.configure(state='disabled')

        relatorio  = {}
        sem_pedido = []

        for nome_pasta, info in sorted(self.alunos_info.items()):
            nome    = info.get('nome', nome_pasta)
            aluno_id = info.get('id', '')
            fotos   = info.get('fotos', [])

            if not fotos:
                continue

            # Foto escolhida por tema ('' = uniforme, a padrao)
            escolhas = self.foto_vars.get(nome_pasta, {})

            def foto_do_tema(tema=''):
                par = escolhas.get(tema) or escolhas.get('')
                if not par:
                    return Path(fotos[0]) if fotos else None
                var, fotos_list = par
                nome_escolhido = var.get()
                return next((Path(f) for f in fotos_list
                             if Path(f).name == nome_escolhido), None)

            foto_path = foto_do_tema('')   # padrao, usada tambem no _SO_AUTORIZOU

            if not foto_path or not foto_path.exists():
                self._log2(f'⚠ {nome}: foto não encontrada')
                continue

            # Busca pedido
            id_curto = aluno_id[:8] if aluno_id else 'SEM ID'
            self._log2(f'🔍 {nome} [id={id_curto}...]')
            try:
                produtos, debug = buscar_pedido_debug(aluno_id)
                for d in debug:
                    self._log2(f'   {d}')
            except Exception as e:
                self._log2(f'   ERRO Supabase: {e}')
                produtos = []

            if not produtos:
                self._log2(f'   📷 só autorizou — sem pedido')
                sem_pedido.append(nome)
                # Copia foto para _SO_AUTORIZOU/Nome - Ano - Turma X/
                pasta_sa = pasta_saida / '_SO_AUTORIZOU' / sanitizar(nome_pasta)
                pasta_sa.mkdir(parents=True, exist_ok=True)
                shutil.copy2(foto_path, pasta_sa / foto_path.name)
                continue

            for item in produtos:
                nome_prod = item['produto']
                qty       = item['quantidade']
                tema      = item.get('tema', '')

                # Produto com tema leva a foto daquele tema; sem tema, a de
                # uniforme. Tema cadastrado depois que as fotos foram escolhidas
                # cai na padrao — melhor entregar com a foto errada avisando do
                # que travar a montagem inteira.
                foto_item = foto_do_tema(tema) or foto_path
                if tema and tema not in escolhas:
                    self._log2(f'   ⚠ {nome_prod}: sem foto escolhida de "{tema}" — usando a de uniforme')

                pasta_p   = pasta_prod / sanitizar(nome_prod)
                pasta_p.mkdir(exist_ok=True)
                ext  = foto_item.suffix
                base = sanitizar(nome)
                for i in range(1, qty + 1):
                    suf = f'_{i}' if qty > 1 else ''
                    shutil.copy2(foto_item, pasta_p / f'{base}{suf}{ext}')
                label = f'{qty}x' if qty > 1 else '1x'
                self._log2(f'   ✓ {nome_prod}: {label}' + (f'  [{tema}: {foto_item.name}]' if tema else ''))

                if nome_prod not in relatorio:
                    relatorio[nome_prod] = {'total': 0, 'alunos': {}}
                relatorio[nome_prod]['total'] += qty
                relatorio[nome_prod]['alunos'][nome] = qty

        # Gera relatório
        rel_path = pasta_saida / '_RELATORIO_IMPRESSAO.txt'
        data_str = datetime.now().strftime('%d/%m/%Y %H:%M')

        # Separa produtos normais de foto de turma
        rel_turma  = {}  # "Ano - Turma" → {produto, total, alunos}
        rel_normal = {}
        for prod, dados in relatorio.items():
            if 'turma' in prod.lower():
                # Agrupa por ano+turma
                for al_nome, qty in dados['alunos'].items():
                    info_al = next((v for v in self.alunos_info.values()
                                    if v.get('nome') == al_nome), {})
                    ano   = info_al.get('ano', '')
                    turma = info_al.get('turma', '')
                    chave = f'{ano} - Turma {turma}' if ano and turma else al_nome
                    if chave not in rel_turma:
                        rel_turma[chave] = {'produto': prod, 'total': 0, 'alunos': {}}
                    rel_turma[chave]['total'] += qty
                    rel_turma[chave]['alunos'][al_nome] = qty
            else:
                rel_normal[prod] = dados

        with open(rel_path, 'w', encoding='utf-8') as f:
            f.write('=' * 55 + '\n')
            f.write('  RELATÓRIO DE IMPRESSÃO — For School\n')
            f.write(f'  Gerado em: {data_str}\n')
            f.write('=' * 55 + '\n\n')
            total_geral = 0

            # Produtos normais
            for prod, dados in sorted(rel_normal.items()):
                t = dados['total']
                total_geral += t
                f.write(f'  {prod:<35} {t:>4} unidade(s)\n')
                for al, q in sorted(dados['alunos'].items()):
                    f.write(f'       • {al:<30} {q}x\n')
                f.write('\n')

            # Foto de turma agrupada por turma
            if rel_turma:
                f.write('─' * 55 + '\n')
                f.write('  FOTO DE TURMA (por turma)\n')
                f.write('─' * 55 + '\n')
                for turma_key, dados in sorted(rel_turma.items()):
                    t = dados['total']
                    total_geral += t
                    f.write(f'  {turma_key:<35} {t:>4} foto(s)\n')
                    for al, q in sorted(dados['alunos'].items()):
                        f.write(f'       • {al:<30} {q}x\n')
                    f.write('\n')

            if sem_pedido:
                f.write('─' * 55 + '\n')
                f.write('  SÓ AUTORIZOU (sem pedido) — fotografar e oferecer\n')
                f.write('─' * 55 + '\n')
                for n in sorted(sem_pedido):
                    f.write(f'       • {n}\n')
                f.write('\n')

            f.write('─' * 55 + '\n')
            f.write(f'  TOTAL GERAL: {total_geral} arquivo(s)\n')
            f.write('=' * 55 + '\n')

        self._log2(f'\n✅ Concluído!')
        self._log2(f'📁 Produtos em: _PRODUTOS/')
        if sem_pedido:
            self._log2(f'📷 Só autorizou ({len(sem_pedido)}): _SO_AUTORIZOU/')
            for n in sem_pedido:
                self._log2(f'   • {n}')
        self._log2(f'📄 Relatório: _RELATORIO_IMPRESSAO.txt')

        # Abre pasta
        try:
            os.startfile(str(pasta_saida))
        except:
            pass

        # Mostra resumo
        resumo = '\n'.join([f'  {p}: {d["total"]}x' for p,d in sorted(relatorio.items())])
        self.after(0, lambda: messagebox.showinfo('Concluído!',
            f'Montagem finalizada!\n\n{resumo}\n\nPasta aberta no Explorer.'))


# ══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    app = App()
    app.mainloop()
