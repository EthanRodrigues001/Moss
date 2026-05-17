alter table public.project_files
  add column if not exists storage_provider text not null default 'supabase'
    check (storage_provider in ('supabase', 'uploadthing')),
  add column if not exists storage_key text,
  add column if not exists public_url text;

update public.project_files
set storage_key = storage_path
where storage_key is null
  and storage_path is not null;

create index if not exists project_files_storage_provider_idx
  on public.project_files(storage_provider);
