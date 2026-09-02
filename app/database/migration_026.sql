-- migration_026: slots de foto por produto
-- Cada slot define onde a foto do aluno será encaixada na moldura
-- Formato: [{x, y, w, h}] em fração (0.0 a 1.0) das dimensões da moldura
-- Rodar no SQL Editor do Supabase

ALTER TABLE products ADD COLUMN IF NOT EXISTS slots JSONB;

-- Como executar:
-- 1. Abrir SQL Editor no Supabase
-- 2. Colar e rodar este script
