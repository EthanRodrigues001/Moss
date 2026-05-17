create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create index if not exists project_files_user_id_idx on public.project_files(user_id);
create index if not exists sections_file_id_idx on public.sections(file_id);
create index if not exists sections_user_id_idx on public.sections(user_id);
create index if not exists citations_user_id_idx on public.citations(user_id);
