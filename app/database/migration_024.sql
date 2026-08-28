-- migration_024: moldura por produto (para editor de montagem)
-- Rodar no SQL Editor do Supabase

ALTER TABLE products ADD COLUMN IF NOT EXISTS frame_url       TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS frame_width_mm  INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS frame_height_mm INTEGER;

-- Como executar:
-- 1. Abrir SQL Editor no Supabase
-- 2. Colar e rodar este script
