-- migration_019.sql
-- Adiciona políticas RLS para pais em order_kits (criada na migration_016 sem essas policies)
-- Executar no SQL Editor do Supabase

-- Pai pode ver os kits dos próprios pedidos
create policy parent_own_order_kits
  on public.order_kits
  for select
  using (
    exists (
      select 1 from public.orders o
      where o.id = order_id
        and o.user_id = auth.uid()
    )
  );

-- Pai pode inserir kits em pedidos próprios
create policy parent_insert_order_kits
  on public.order_kits
  for insert
  with check (
    exists (
      select 1 from public.orders o
      where o.id = order_id
        and o.user_id = auth.uid()
    )
  );
