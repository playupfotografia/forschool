-- migration_022: função para deletar usuário do auth quando não tem mais alunos
-- Como executar: cole no SQL Editor do Supabase e clique em Run.

-- Função com SECURITY DEFINER para ter acesso ao schema auth
CREATE OR REPLACE FUNCTION public.delete_parent_if_no_students(uid uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Só apaga se realmente não há mais alunos vinculados a esse responsável
  IF NOT EXISTS (SELECT 1 FROM public.students WHERE user_id = uid) THEN
    DELETE FROM auth.users WHERE id = uid;
    -- public.users será apagado em cascata (ON DELETE CASCADE)
  END IF;
END;
$$;

-- Garantir que só admins podem chamar essa função
REVOKE ALL ON FUNCTION public.delete_parent_if_no_students(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_parent_if_no_students(uuid) TO authenticated;

-- Política de segurança: a função só executa a deleção se chamada por um admin
-- (a verificação de is_admin() é feita no admin.html antes de chamar)
