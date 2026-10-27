"""Visual moderno do For School - Organizador de Fotos.

Menu lateral escuro com a marca, cabecalho por pagina, pagina Inicio
("continuar de onde parei") e pagina de Ajuda com passo a passo, atalhos e
perguntas frequentes. O programa em si (ForSchool_Fotos.py) so' chama as
funcoes daqui; se este arquivo faltar, ele cai no visual classico.
"""
import json
import tkinter as tk
from tkinter import ttk
from pathlib import Path
from datetime import datetime

PASTA = Path(__file__).resolve().parent
ASSETS = PASTA / 'assets'
FONTE = 'Segoe UI'

C = dict(
    bg='#F7F8FC', card='#FFFFFF', borda='#DDE3F0', texto='#1E293B', suave='#64748B',
    azul='#2F55F5', azul_esc='#2344D0', azul_claro='#E8EEFF',
    menu='#141B4D', menu_hover='#1D2762', menu_ativo='#27327A', menu_txt='#B9C2F2',
    amarelo='#FFC93C', verde='#22A559', laranja='#F28C4B', vermelho='#E5484D',
    rosa='#F25BA8',
)


def escurecer(hex_cor, f=0.86):
    h = hex_cor.lstrip('#')
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return '#%02x%02x%02x' % (int(r * f), int(g * f), int(b * f))


def imagem(nome, lado=None):
    """PhotoImage de assets/<nome> (None se faltar/der erro). Guarde a referencia."""
    try:
        from PIL import Image, ImageTk
        im = Image.open(ASSETS / nome).convert('RGBA')
        if lado:
            im.thumbnail((lado, lado), Image.LANCZOS)
        return ImageTk.PhotoImage(im)
    except Exception:
        return None


def aplicar_icone(app):
    """Icone da janela e da barra de tarefas."""
    try:
        app._icone_janela = imagem('icone.png', 128)
        if app._icone_janela:
            app.iconphoto(True, app._icone_janela)
    except Exception:
        pass
    try:
        ico = ASSETS / 'icone.ico'
        if ico.exists():
            app.iconbitmap(str(ico))
    except Exception:
        pass


def botao_hover(b, cor, cor_hover=None):
    """Efeito de passar o mouse num tk.Button plano."""
    cor_hover = cor_hover or escurecer(cor)

    def entrar(_e):
        if str(b['state']) != 'disabled':
            b.config(bg=cor_hover)

    def sair(_e):
        if str(b['state']) != 'disabled':
            b.config(bg=cor)
    b.bind('<Enter>', entrar)
    b.bind('<Leave>', sair)
    return b


def estilo_ttk(app):
    st = ttk.Style(app)
    st.theme_use('clam')
    # Abas escondidas: quem navega e' o menu lateral.
    st.layout('Pag.TNotebook.Tab', [])
    st.configure('Pag.TNotebook', background=C['bg'], borderwidth=0, tabmargins=0,
                 bordercolor=C['bg'], lightcolor=C['bg'], darkcolor=C['bg'])
    for orient in ('Vertical', 'Horizontal'):
        st.configure(f'{orient}.TScrollbar', troughcolor=C['bg'], background='#C9D2E8',
                     bordercolor=C['bg'], lightcolor='#C9D2E8', darkcolor='#C9D2E8',
                     arrowcolor=C['suave'], relief='flat', gripcount=0)
        st.map(f'{orient}.TScrollbar', background=[('active', '#AEBBDD')])


# ══════════════════════════════════════════════════════════════════════════════
# Casca: menu lateral + cabecalho + paginas
# ══════════════════════════════════════════════════════════════════════════════

def montar_casca(app):
    """Cria menu lateral e area de conteudo. Define app.nb (abas escondidas)."""
    app.configure(bg=C['bg'])
    aplicar_icone(app)
    estilo_ttk(app)

    app._lado = tk.Frame(app, bg=C['menu'], width=236)
    app._lado.pack(side='left', fill='y')
    app._lado.pack_propagate(False)

    # Marca
    topo = tk.Frame(app._lado, bg=C['menu'])
    topo.pack(fill='x', pady=(18, 6))
    app._img_marca = imagem('icone.png', 150)
    if app._img_marca:
        tk.Label(topo, image=app._img_marca, bg=C['menu']).pack()
    else:
        tk.Label(topo, text='For School', bg=C['menu'], fg='white',
                 font=(FONTE, 20, 'bold')).pack()
    tk.Label(topo, text='ORGANIZADOR DE FOTOS', bg=C['menu'], fg=C['amarelo'],
             font=(FONTE, 8, 'bold')).pack(pady=(2, 0))

    app._nav = tk.Frame(app._lado, bg=C['menu'])
    app._nav.pack(fill='x', pady=(18, 0))

    # Rodape do menu: conexao + versao
    app._lado_rodape = tk.Frame(app._lado, bg=C['menu'])
    app._lado_rodape.pack(side='bottom', fill='x', padx=18, pady=16)

    # Area da direita
    direita = tk.Frame(app, bg=C['bg'])
    direita.pack(side='left', fill='both', expand=True)

    cab = tk.Frame(direita, bg=C['card'])
    cab.pack(fill='x')
    app._cab_titulo = tk.Label(cab, text='', bg=C['card'], fg=C['texto'],
                               font=(FONTE, 18, 'bold'), anchor='w')
    app._cab_titulo.pack(fill='x', padx=28, pady=(16, 0))
    app._cab_sub = tk.Label(cab, text='', bg=C['card'], fg=C['suave'],
                            font=(FONTE, 10), anchor='w', justify='left')
    app._cab_sub.pack(fill='x', padx=28, pady=(0, 14))
    tk.Frame(direita, bg=C['borda'], height=1).pack(fill='x')

    app.nb = ttk.Notebook(direita, style='Pag.TNotebook')
    app.nb.pack(fill='both', expand=True, padx=22, pady=(14, 14))


class _ItemMenu:
    def __init__(self, pai, icone, rotulo, comando):
        self.ativo = False
        self.f = tk.Frame(pai, bg=C['menu'], cursor='hand2')
        self.f.pack(fill='x', pady=1)
        self.barra = tk.Frame(self.f, bg=C['menu'], width=4)
        self.barra.pack(side='left', fill='y')
        self.ic = tk.Label(self.f, text=icone, bg=C['menu'], fg=C['menu_txt'],
                           font=('Segoe UI Emoji', 13), width=3)
        self.ic.pack(side='left', pady=9)
        self.tx = tk.Label(self.f, text=rotulo, bg=C['menu'], fg=C['menu_txt'],
                           font=(FONTE, 11, 'bold'), anchor='w')
        self.tx.pack(side='left', fill='x', expand=True)
        for w in (self.f, self.ic, self.tx, self.barra):
            w.bind('<Button-1>', lambda e: comando())
            w.bind('<Enter>', lambda e: self._pintar(hover=True))
            w.bind('<Leave>', lambda e: self._pintar(hover=False))

    def _pintar(self, hover=False):
        if self.ativo:
            fundo, fg, barra = C['menu_ativo'], 'white', C['amarelo']
        elif hover:
            fundo, fg, barra = C['menu_hover'], 'white', C['menu_hover']
        else:
            fundo, fg, barra = C['menu'], C['menu_txt'], C['menu']
        for w in (self.f, self.ic, self.tx):
            w.config(bg=fundo)
        self.ic.config(fg=fg)
        self.tx.config(fg=fg)
        self.barra.config(bg=barra)

    def marcar(self, ativo):
        self.ativo = ativo
        self._pintar()


def registrar_paginas(app, paginas):
    """paginas: lista de (frame, icone, rotulo_menu, titulo, subtitulo, separador_antes)."""
    app._paginas = {}
    for frame, icone, rotulo, titulo, sub, sep in paginas:
        if sep:
            tk.Frame(app._nav, bg=C['menu_hover'], height=1).pack(fill='x', padx=18, pady=10)
        item = _ItemMenu(app._nav, icone, rotulo, lambda f=frame: app.nb.select(f))
        app._paginas[str(frame)] = (item, titulo, sub)

    def mudou(_e=None):
        try:
            atual = str(app.nb.nametowidget(app.nb.select()))
        except Exception:
            return
        for chave, (item, titulo, sub) in app._paginas.items():
            item.marcar(chave == atual)
            if chave == atual:
                app._cab_titulo.config(text=titulo)
                app._cab_sub.config(text=sub)
        if hasattr(app, '_ao_mudar_pagina'):
            app._ao_mudar_pagina(atual)
    app.nb.bind('<<NotebookTabChanged>>', mudou)
    app.after(50, mudou)


def rodape_menu(app, conectado, versao_txt):
    for w in app._lado_rodape.winfo_children():
        w.destroy()
    linha = tk.Frame(app._lado_rodape, bg=C['menu'])
    linha.pack(fill='x')
    cor = C['verde'] if conectado else C['vermelho']
    tk.Label(linha, text='●', bg=C['menu'], fg=cor, font=(FONTE, 11)).pack(side='left')
    tk.Label(linha, text='Banco conectado' if conectado else 'Sem conexão com o banco',
             bg=C['menu'], fg=C['menu_txt'], font=(FONTE, 9, 'bold')).pack(side='left', padx=(4, 0))
    tk.Label(app._lado_rodape, text=versao_txt, bg=C['menu'], fg='#7F89C9',
             font=(FONTE, 8), anchor='w').pack(fill='x', pady=(4, 0))


# ══════════════════════════════════════════════════════════════════════════════
# Pedacos reutilizaveis
# ══════════════════════════════════════════════════════════════════════════════

def cartao(pai, **kw):
    f = tk.Frame(pai, bg=C['card'], highlightbackground=C['borda'], highlightthickness=1, **kw)
    return f


def botao(pai, texto, cmd, cor=None, fg='white', **kw):
    cor = cor or C['azul']
    b = tk.Button(pai, text=texto, command=cmd, bg=cor, fg=fg, relief='flat', bd=0,
                  font=(FONTE, 10, 'bold'), padx=16, pady=7, cursor='hand2',
                  activebackground=escurecer(cor), activeforeground=fg, **kw)
    return botao_hover(b, cor)


# ══════════════════════════════════════════════════════════════════════════════
# Pagina INICIO
# ══════════════════════════════════════════════════════════════════════════════

def montar_inicio(app, frame, recentes, abrir_pasta):
    for w in frame.winfo_children():
        w.destroy()
    frame.configure(bg=C['bg'])

    tk.Label(frame, text='Vamos organizar as fotos de hoje? 👋', bg=C['bg'], fg=C['texto'],
             font=(FONTE, 15, 'bold'), anchor='w').pack(fill='x', pady=(4, 2))
    tk.Label(frame, text='Siga as 2 etapas abaixo, em ordem. Em caso de dúvida, abra a Ajuda no menu à esquerda.',
             bg=C['bg'], fg=C['suave'], font=(FONTE, 10), anchor='w').pack(fill='x', pady=(0, 12))

    linha = tk.Frame(frame, bg=C['bg'])
    linha.pack(fill='x')
    etapas = [
        ('1', C['azul'], 'Organizar por aluno',
         'Aponte a pasta do cartão de memória. O programa lê o QR de cada ficha e separa as fotos em uma pasta por aluno.',
         'Começar', lambda: app.nb.select(app.tab1)),
        ('2', C['verde'], 'Escolher e montar',
         'Escolha a melhor foto de cada tema para cada aluno e gere os produtos prontos para imprimir.',
         'Abrir pasta organizada', lambda: app._menu_abrir()),
        ('?', C['laranja'], 'Tutorial e dúvidas',
         'Passo a passo ilustrado, atalhos do teclado e respostas para os problemas mais comuns.',
         'Abrir a Ajuda', lambda: app.nb.select(app.tab4)),
    ]
    for i, (num, cor, titulo, desc, rotulo, cmd) in enumerate(etapas):
        linha.columnconfigure(i, weight=1, uniform='etapas')
        c = cartao(linha)
        c.grid(row=0, column=i, sticky='nsew', padx=(0 if i == 0 else 8, 0))
        tk.Frame(c, bg=cor, height=5).pack(fill='x')
        corpo = tk.Frame(c, bg=C['card'])
        corpo.pack(fill='both', expand=True, padx=16, pady=14)
        topo = tk.Frame(corpo, bg=C['card'])
        topo.pack(fill='x')
        tk.Label(topo, text=num, bg=cor, fg='white', font=(FONTE, 12, 'bold'),
                 width=3, pady=2).pack(side='left')
        tk.Label(topo, text=titulo, bg=C['card'], fg=C['texto'], font=(FONTE, 12, 'bold'),
                 anchor='w').pack(side='left', padx=10)
        tk.Label(corpo, text=desc, bg=C['card'], fg=C['suave'], font=(FONTE, 10),
                 wraplength=250, justify='left', anchor='w').pack(fill='x', pady=(10, 12))
        botao(corpo, rotulo + '  →', cmd, cor=cor).pack(anchor='w', side='bottom')

    # Continuar de onde parei
    tk.Label(frame, text='Continuar de onde parei', bg=C['bg'], fg=C['texto'],
             font=(FONTE, 12, 'bold'), anchor='w').pack(fill='x', pady=(20, 6))
    box = cartao(frame)
    box.pack(fill='x')
    if not recentes:
        tk.Label(box, text='Quando você abrir uma pasta organizada, ela aparece aqui para reabrir com 1 clique.',
                 bg=C['card'], fg=C['suave'], font=(FONTE, 10), pady=16).pack()
    for p in recentes[:5]:
        pp = Path(p)
        r = tk.Frame(box, bg=C['card'])
        r.pack(fill='x', padx=14, pady=6)
        tk.Label(r, text='📁', bg=C['card'], font=('Segoe UI Emoji', 14)).pack(side='left')
        txt = tk.Frame(r, bg=C['card'])
        txt.pack(side='left', padx=10, fill='x', expand=True)
        tk.Label(txt, text=pp.name or str(pp), bg=C['card'], fg=C['texto'],
                 font=(FONTE, 10, 'bold'), anchor='w').pack(fill='x')
        tk.Label(txt, text=str(pp.parent), bg=C['card'], fg=C['suave'],
                 font=(FONTE, 8), anchor='w').pack(fill='x')
        botao(r, 'Abrir', lambda p=p: abrir_pasta(p), cor=C['azul_claro'], fg=C['azul']).pack(side='right')


# ══════════════════════════════════════════════════════════════════════════════
# Pagina AJUDA
# ══════════════════════════════════════════════════════════════════════════════

PASSOS = [
    ('Antes da sessão (no painel online)',
     'No painel For School, imprima as fichas com QR code dos alunos (Alunos → Fichas por turma) '
     'e, se for fotografar a turma toda, o cartão de QR de foto de turma.'),
    ('Durante a sessão',
     'Fotografe a ficha do aluno ANTES de fotografar o aluno. Trocou de roupa/tema? Fotografe a ficha '
     'de novo: cada vez que o QR aparece, o programa abre um novo "bloco" de fotos para aquele aluno. '
     'Foto da turma inteira: fotografe antes o cartão de QR da turma.'),
    ('Etapa 1 · Organizar por aluno',
     'Menu "Organizar fotos". Escolha a pasta do cartão de memória, clique em "Organizar fotos por aluno" '
     'e aguarde. O programa cria uma pasta por aluno, com o nome da criança, o ano e a turma.'),
    ('Etapa 2 · Escolher as fotos',
     'Menu "Escolher e montar". Abra a pasta organizada e clique em "🔍 Escolher" em qualquer aluno: abre '
     'o visor em tela cheia. Use as setas para passar as fotos e as teclas 1, 2, 3… (ou os botões) para '
     'dizer "esta foto é o Uniforme / Natal / …". Ao chegar na última foto, ele já entra no próximo aluno.'),
    ('Lightroom (opcional)',
     '"Exportar escolhidas p/ Lightroom" copia só as fotos escolhidas. Trate no Lightroom e exporte para a '
     'pasta "_TRATADAS" mantendo o nome original do arquivo. Na montagem, o programa usa a versão tratada.'),
    ('Montar e entregar',
     '"✅ Montar e salvar tudo" gera as pastas por produto (_PRODUTOS), a pasta de quem só autorizou '
     '(_SO_AUTORIZOU) e o relatório de impressão. "🖼 Enviar miniaturas" manda as fotos para o painel da entrega.'),
]

ATALHOS = [
    ('← →', 'Foto anterior / próxima (no fim do aluno, já entra no seguinte)'),
    ('1 · 2 · 3 …', 'Marca a foto atual como o tema 1, 2, 3… Apertar de novo cancela'),
    ('Espaço', 'Marca a foto para mover para outro aluno'),
    ('End', 'Marca da foto atual até a última do aluno'),
    ('Delete', 'Limpa as marcas'),
    ('↑ ↓', 'Pula de bloco (volta do QR) dentro do mesmo aluno'),
    ('PgUp · PgDn', 'Aluno anterior / próximo'),
    ('Esc', 'Fecha o visor'),
    ('Ctrl + O', 'Abrir pasta já organizada'),
    ('Ctrl + S', 'Salvar escolhas'),
]

FAQ = [
    ('O programa avisa "Falta o arquivo de credenciais". E agora?',
     'Esse arquivo (supabase.local.env) guarda o endereço e a chave do seu banco e não vem junto com o programa, '
     'por segurança. Quando o programa pedir, clique em "Sim" e selecione o arquivo. Ele é copiado para a pasta do '
     'programa e você não precisa repetir. Não envie esse arquivo por WhatsApp ou e-mail.'),
    ('Esqueci de fotografar a ficha e as fotos de um aluno caíram na pasta do colega.',
     'Na Etapa 2, abra o visor "Escolher" do colega. Marque as fotos erradas com Espaço (ou "End" para marcar até '
     'a última) e clique em "➡ Mover p/ outro aluno". Se o aluno nem tem pasta, use "➕ Aluno sem pasta" e busque pelo nome.'),
    ('O QR de um aluno não foi lido.',
     'Normal acontecer com foto tremida ou ficha amassada. As fotos vão para a pasta do aluno anterior (ou para '
     '"_sem_aluno"). Use o visor para mover as fotos para o aluno certo.'),
    ('Escolhi a foto errada para um tema. Como desfazer?',
     'No visor, clique no ✕ vermelho ao lado do tema, ou aperte de novo o número do tema na mesma foto.'),
    ('Como crio os botões de tema (Natal, Páscoa, Formatura…)?',
     'Menu Ferramentas → ⚙ Temas. Adicione quantos quiser, na ordem que preferir. Para a montagem automática, '
     'o nome do tema precisa ser igual ao "Tema da foto" do produto no painel online.'),
    ('As escolhas são salvas sozinhas?',
     'Sim, a cada clique, no arquivo _escolhas.json dentro da pasta organizada. Para guardar uma cópia, use '
     'Arquivo → Salvar escolhas como. Para exportar uma lista em planilha: Arquivo → Exportar lista de escolhas.'),
    ('Movi a pasta organizada para outro lugar. Perdi tudo?',
     'Não. Use Arquivo → Abrir pasta já organizada e aponte para o novo local. O programa reajusta os caminhos.'),
    ('Alunos que estão na pasta mas não aparecem na lista.',
     'Ao abrir a pasta, o programa recupera sozinho as pastas de alunos que ficaram fora do índice e avisa quantos '
     'voltaram. Os que ficam sem vínculo com o cadastro precisam ser ligados em "Aluno sem pasta".'),
    ('Como atualizo o programa?',
     'Ele confere sozinho ao abrir, se houver internet. Para forçar: menu "Atualizar" → "Verificar e atualizar agora" '
     'e depois "Reiniciar o programa".'),
    ('Preciso usar em outro computador.',
     'Instale com o instalador do programa e copie o arquivo supabase.local.env por pen drive (ou selecione-o '
     'quando o programa pedir). As fotos e as pastas organizadas podem ser copiadas normalmente.'),
    ('O Windows avisou "O Windows protegeu o computador".',
     'Aparece em programas sem assinatura digital paga. Clique em "Mais informações" e depois em "Executar assim mesmo".'),
]


class _Acordeao:
    def __init__(self, pai, titulo, texto):
        self.titulo, self.texto = titulo, texto
        self.aberto = False
        self.box = cartao(pai)
        self.box.pack(fill='x', pady=3)
        self.cab = tk.Frame(self.box, bg=C['card'], cursor='hand2')
        self.cab.pack(fill='x')
        self.seta = tk.Label(self.cab, text='▸', bg=C['card'], fg=C['azul'], font=(FONTE, 12, 'bold'))
        self.seta.pack(side='left', padx=(12, 6), pady=10)
        self.rot = tk.Label(self.cab, text=titulo, bg=C['card'], fg=C['texto'],
                            font=(FONTE, 10, 'bold'), anchor='w', justify='left', wraplength=620)
        self.rot.pack(side='left', fill='x', expand=True, pady=10)
        self.corpo = tk.Label(self.box, text=texto, bg=C['card'], fg=C['suave'], font=(FONTE, 10),
                              anchor='w', justify='left', wraplength=700)
        for w in (self.cab, self.seta, self.rot):
            w.bind('<Button-1>', lambda e: self.alternar())

    def alternar(self):
        self.aberto = not self.aberto
        if self.aberto:
            self.corpo.pack(fill='x', padx=(32, 14), pady=(0, 12))
            self.seta.config(text='▾')
        else:
            self.corpo.pack_forget()
            self.seta.config(text='▸')


def montar_ajuda(app, frame):
    frame.configure(bg=C['bg'])
    canvas = tk.Canvas(frame, bg=C['bg'], highlightthickness=0)
    sb = ttk.Scrollbar(frame, orient='vertical', command=canvas.yview)
    conteudo = tk.Frame(canvas, bg=C['bg'])
    janela = canvas.create_window((0, 0), window=conteudo, anchor='nw')
    conteudo.bind('<Configure>', lambda e: canvas.configure(scrollregion=canvas.bbox('all')))
    canvas.bind('<Configure>', lambda e: canvas.itemconfig(janela, width=e.width))
    canvas.configure(yscrollcommand=sb.set)
    canvas.pack(side='left', fill='both', expand=True)
    sb.pack(side='right', fill='y')
    app._canvas_ajuda = canvas

    def titulo(txt, sub=None):
        tk.Label(conteudo, text=txt, bg=C['bg'], fg=C['texto'], font=(FONTE, 13, 'bold'),
                 anchor='w').pack(fill='x', pady=(18, 2))
        if sub:
            tk.Label(conteudo, text=sub, bg=C['bg'], fg=C['suave'], font=(FONTE, 10),
                     anchor='w').pack(fill='x', pady=(0, 6))

    # Passo a passo
    titulo('Passo a passo', 'Do cartão de memória até os produtos prontos.')
    for n, (t, d) in enumerate(PASSOS, 1):
        c = cartao(conteudo)
        c.pack(fill='x', pady=3)
        tk.Label(c, text=str(n), bg=C['azul'], fg='white', font=(FONTE, 12, 'bold'),
                 width=3, height=1).pack(side='left', padx=12, pady=12, anchor='n')
        col = tk.Frame(c, bg=C['card'])
        col.pack(side='left', fill='x', expand=True, pady=10)
        tk.Label(col, text=t, bg=C['card'], fg=C['texto'], font=(FONTE, 10, 'bold'),
                 anchor='w').pack(fill='x')
        tk.Label(col, text=d, bg=C['card'], fg=C['suave'], font=(FONTE, 10), anchor='w',
                 justify='left', wraplength=700).pack(fill='x', pady=(2, 0))

    # Atalhos
    titulo('Atalhos do teclado', 'No visor "Escolher foto" você escolhe tudo sem tirar a mão do teclado.')
    g = cartao(conteudo)
    g.pack(fill='x')
    for i, (tecla, desc) in enumerate(ATALHOS):
        tk.Label(g, text=tecla, bg=C['azul_claro'], fg=C['azul'], font=('Consolas', 10, 'bold'),
                 width=13, pady=3).grid(row=i, column=0, padx=(12, 10), pady=4, sticky='w')
        tk.Label(g, text=desc, bg=C['card'], fg=C['texto'], font=(FONTE, 10),
                 anchor='w').grid(row=i, column=1, sticky='w', pady=4)
    g.columnconfigure(1, weight=1)

    # FAQ com busca
    titulo('Perguntas frequentes', 'Clique na pergunta para ver a resposta. Ou procure pelo assunto:')
    busca = tk.StringVar()
    ent = tk.Entry(conteudo, textvariable=busca, font=(FONTE, 11), relief='flat',
                   highlightthickness=1, highlightbackground=C['borda'], highlightcolor=C['azul'])
    ent.pack(fill='x', ipady=6, pady=(0, 8))
    lista = tk.Frame(conteudo, bg=C['bg'])
    lista.pack(fill='x')
    itens = [_Acordeao(lista, t, d) for t, d in FAQ]
    vazio = tk.Label(lista, text='Nenhuma pergunta com esse assunto. Fale com quem forneceu o programa.',
                     bg=C['bg'], fg=C['suave'], font=(FONTE, 10))

    def filtrar(*_):
        q = busca.get().strip().casefold()
        achou = 0
        for it in itens:
            ok = not q or q in it.titulo.casefold() or q in it.texto.casefold()
            if ok:
                it.box.pack(fill='x', pady=3)
                achou += 1
            else:
                it.box.pack_forget()
        if achou == 0:
            vazio.pack(pady=12)
        else:
            vazio.pack_forget()
    busca.trace_add('write', filtrar)

    tk.Label(conteudo, text='', bg=C['bg']).pack(pady=14)
