// ============================================================================
// FOR SCHOOL — Cliente Supabase
// ============================================================================
// Setup central do cliente Supabase + helpers reutilizáveis em todas as telas.
// Importado como módulo ES nas páginas HTML.
// ============================================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Credenciais públicas — anon key é segura no frontend (RLS protege os dados)
const SUPABASE_URL = 'https://drxnaumaxcabjyfubuva.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRyeG5hdW1heGNhYmp5ZnVidXZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3ODc3OTcsImV4cCI6MjA5NjM2Mzc5N30.CtDJo-60rSrGlknX9DlpvDWuvnL8-yKeT6pYXXz--EM';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,    // mantém login após fechar navegador
    autoRefreshToken: true,  // renova token automaticamente
  }
});

// ----------------------------------------------------------------------------
// Helpers de autenticação
// ----------------------------------------------------------------------------

export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function isAdmin() {
  const user = await getCurrentUser();
  if (!user) return false;
  return user.app_metadata?.role === 'admin';
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

/**
 * Cadastra um novo pai/responsável.
 * O metadado (name, cpf, phone) vai pra raw_user_meta_data,
 * e o trigger handle_new_user no banco cria automaticamente a linha em public.users.
 */
export async function signUp(email, password, meta = {}) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: meta }
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// Helpers de UI
// ----------------------------------------------------------------------------

export function fmtMoney(v) {
  return 'R$ ' + parseFloat(v || 0).toFixed(2).replace('.', ',');
}

export function toast(msg, tipo = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  const colors = { ok: 'var(--green)', warn: 'var(--orange)', error: 'var(--red)', info: 'var(--blue)' };
  el.style.borderLeftColor = colors[tipo] || colors.info;
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 2800);
}

// ----------------------------------------------------------------------------
// Storage — upload de imagens
// ----------------------------------------------------------------------------

/**
 * Faz upload de uma imagem pro bucket `product-images` e retorna a URL pública.
 * @param {File} file - arquivo de imagem
 * @returns {Promise<string>} URL pública da imagem
 */
export async function uploadProductImage(file, folder = 'produtos') {
  if (!file) throw new Error('Nenhum arquivo selecionado');
  if (!file.type.startsWith('image/')) throw new Error('O arquivo precisa ser uma imagem (JPG, PNG, etc.)');
  if (file.size > 10 * 1024 * 1024) throw new Error('Imagem muito grande (máx 10 MB)');

  const ext = file.name.split('.').pop().toLowerCase();
  const safeExt = ['jpg','jpeg','png','gif','webp','avif'].includes(ext) ? ext : 'jpg';
  const safeFolder = (folder || 'produtos').replace(/[^a-z0-9_-]/gi, '');
  const fileName = `${safeFolder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`;

  const { error: upErr } = await supabase.storage
    .from('product-images')
    .upload(fileName, file, { cacheControl: '3600', upsert: false });

  if (upErr) {
    if (upErr.message?.includes('not found') || upErr.message?.includes('Bucket')) {
      throw new Error('Bucket "product-images" não existe. Crie no Supabase Storage primeiro.');
    }
    throw upErr;
  }

  const { data } = supabase.storage.from('product-images').getPublicUrl(fileName);
  return data.publicUrl;
}

// ----------------------------------------------------------------------------
// Logging de erros (centraliza tratamento)
// ----------------------------------------------------------------------------

export function handleError(err, contexto = '') {
  console.error(`[${contexto}]`, err);
  toast(err.message || 'Erro inesperado', 'error');
}
