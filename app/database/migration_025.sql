-- migration_025: imagens extras por produto (até 3 fotos adicionais opcionais)
-- Rodar no SQL Editor do Supabase

ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url_2 TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url_3 TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url_4 TEXT;

-- Como executar:
-- 1. Abrir SQL Editor no Supabase
-- 2. Colar e rodar este script
