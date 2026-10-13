-- migration_066: hora do corte da entrega, POR PROJETO
--
-- O corte da entrega ("N dias antes da entrega o pedido deixa de alcancar o lote
-- da escola e passa a ter taxa de motoboy") era so' por DATA, e valia na virada
-- do dia no relogio do servidor (UTC = 21h do dia anterior em Brasilia).
--
-- Esta coluna permite fixar a HORA (horario de Brasilia) do corte num projeto.
-- Vazia (padrao, todos os projetos existentes) = comportamento de sempre.
-- Preenchida (ex: 9) = o corte vale a partir das 09:00 de Brasilia do dia
-- [data de entrega - dias de corte].
--
-- Como executar: Supabase -> SQL Editor -> colar tudo e Run. Rodar ANTES de subir
-- o codigo (salvar-pedido.js passa a ler esta coluna).

alter table public.projects
  add column if not exists delivery_cutoff_hour smallint
  check (delivery_cutoff_hour is null or (delivery_cutoff_hour between 0 and 23));
