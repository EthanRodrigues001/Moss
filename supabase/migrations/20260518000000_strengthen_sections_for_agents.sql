alter table public.sections
  add column if not exists section_key text,
  add column if not exists file_path text,
  add column if not exists source_text text;

update public.sections
set
  section_key = coalesce(section_key, id::text),
  file_path = coalesce(file_path, ''),
  source_text = coalesce(source_text, '')
where section_key is null
  or file_path is null
  or source_text is null;

alter table public.sections
  alter column section_key set not null,
  alter column file_path set not null,
  alter column source_text set not null;

create unique index if not exists sections_project_file_section_key_idx
  on public.sections(project_id, file_id, section_key);

create index if not exists sections_project_file_path_idx
  on public.sections(project_id, file_path);
