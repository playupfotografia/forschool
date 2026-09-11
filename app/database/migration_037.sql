-- migration_037: pedido manual + link de pagamento publico (sem login)
--
-- Contexto:
--   Responsavel idoso, sem pratica nenhuma com celular/portal — nao consegue
--   se cadastrar nem fazer o pedido sozinho. O Daniel cadastra o pedido
--   manualmente pelo admin e manda um LINK direto de pagamento pelo
--   WhatsApp, sem exigir login nenhum (ele so' abre o link).
--
-- O que muda:
--   1. orders.payment_link_token — token aleatorio (gerado no admin.html via
--      crypto.randomUUID(), nao pelo banco) que identifica o pedido nesse
--      link publico. Nasce vazio pra todo pedido que ja existe.
--   2. Funcao get_pedido_publico() — dado o token, devolve so' o necessario
--      pra montar a pagina de pagamento (nome do aluno, escola, turma,
--      itens, valor, status, link do cartao se ja gerado, e a chave Pix
--      configurada) — SECURITY DEFINER porque a pagina e' publica, sem
--      sessao de login, e a RLS normal de orders/app_settings exigiria uma.
--      Nao devolve CPF, telefone, e-mail nem nenhum outro pedido.
--
-- Rodar no SQL Editor do Supabase.

alter table public.orders
  add column if not exists payment_link_token text unique;

create index if not exists idx_orders_payment_link_token on public.orders(payment_link_token);

create or replace function public.get_pedido_publico(p_token text)
returns table(
  order_id uuid,
  order_number text,
  total_amount numeric,
  payment_status text,
  student_name text,
  class_name text,
  year_name text,
  school_name text,
  kit_name text,
  itens jsonb,
  checkout_url text,
  pix_key text,
  pix_key_type text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
    o.id, o.order_number, o.total_amount, o.payment_status,
    s.name, sc.name, sy.name, sch.name,
    sk.name,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'nome', p.name, 'quantidade', oi.quantity, 'variante', oi.variant_name
      ))
      from public.order_items oi
      left join public.products p on p.id = oi.product_id
      where oi.order_id = o.id
    ), '[]'::jsonb),
    o.checkout_url,
    cfg.pix_key,
    cfg.pix_key_type
  from public.orders o
  join public.students s on s.id = o.student_id
  left join public.school_classes sc on sc.id = s.class_id
  left join public.school_years sy on sy.id = sc.year_id
  join public.schools sch on sch.id = o.school_id
  left join public.order_kits ok on ok.order_id = o.id
  left join public.school_kits sk on sk.id = ok.kit_id
  cross join public.app_settings cfg
  where o.payment_link_token = p_token
    and cfg.id = 1
  limit 1;
end;
$$;

revoke all on function public.get_pedido_publico(text) from public;
grant execute on function public.get_pedido_publico(text) to anon, authenticated;

-- ============================================================================
-- FIM. Nada em pedidos existentes ou no fluxo normal do portal e' alterado —
-- so' coluna nova (vazia) e funcao nova, que so' responde quando ha' um
-- token valido.
--
-- Resultado esperado: "Success. No rows returned"
-- Confira: orders com a coluna payment_link_token nova (tudo null), e em
-- Database > Functions a get_pedido_publico deve aparecer listada.
-- ============================================================================
