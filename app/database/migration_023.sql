-- migration_023: campo photo_url nos alunos (para carômetro)
-- Rodar no SQL Editor do Supabase

ALTER TABLE students ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- Política de Storage para o bucket "media" (carômetro)
-- As políticas de INSERT/SELECT já existem no bucket media, então apenas a pasta
-- carometro/ será usada automaticamente com as políticas existentes.

-- Como executar:
-- 1. Abrir SQL Editor no Supabase
-- 2. Colar e rodar este script
