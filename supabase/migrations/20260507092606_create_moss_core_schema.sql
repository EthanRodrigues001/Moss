create extension if not exists pgcrypto;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(trim(title)) > 0),
  root_file_path text not null default 'main.tex',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  path text not null,
  kind text not null check (kind in ('tex', 'bib', 'style', 'class', 'bst', 'image', 'pdf', 'asset', 'folder')),
  content_text text,
  storage_path text,
  mime_type text,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, path)
);

create table if not exists public.sections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  file_id uuid references public.project_files(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  heading text not null,
  level integer not null check (level between 1 and 6),
  order_index integer not null default 0,
  content_hash text not null,
  source_start integer not null default 0,
  source_end integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.citations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  cite_key text not null,
  csl_json jsonb not null default '{}'::jsonb,
  bibtex text not null default '',
  tags text[] not null default '{}',
  updated_at timestamptz not null default now(),
  unique (project_id, cite_key)
);

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

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
before update on public.projects
for each row execute function public.set_updated_at();

drop trigger if exists project_files_set_updated_at on public.project_files;
create trigger project_files_set_updated_at
before update on public.project_files
for each row execute function public.set_updated_at();

drop trigger if exists sections_set_updated_at on public.sections;
create trigger sections_set_updated_at
before update on public.sections
for each row execute function public.set_updated_at();

drop trigger if exists citations_set_updated_at on public.citations;
create trigger citations_set_updated_at
before update on public.citations
for each row execute function public.set_updated_at();

alter table public.projects enable row level security;
alter table public.project_files enable row level security;
alter table public.sections enable row level security;
alter table public.citations enable row level security;

drop policy if exists "Users manage own projects" on public.projects;
create policy "Users manage own projects" on public.projects
for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage own project files" on public.project_files;
create policy "Users manage own project files" on public.project_files
for all to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.projects
    where projects.id = project_files.project_id
      and projects.user_id = (select auth.uid())
  )
);

drop policy if exists "Users manage own sections" on public.sections;
create policy "Users manage own sections" on public.sections
for all to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.projects
    where projects.id = sections.project_id
      and projects.user_id = (select auth.uid())
  )
);

drop policy if exists "Users manage own citations" on public.citations;
create policy "Users manage own citations" on public.citations
for all to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.projects
    where projects.id = citations.project_id
      and projects.user_id = (select auth.uid())
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'project-assets',
  'project-assets',
  false,
  52428800,
  array['image/png', 'image/jpeg', 'application/pdf', 'image/svg+xml', 'application/octet-stream']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users read own project assets" on storage.objects;
create policy "Users read own project assets" on storage.objects
for select to authenticated
using (
  bucket_id = 'project-assets'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Users upload own project assets" on storage.objects;
create policy "Users upload own project assets" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'project-assets'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Users update own project assets" on storage.objects;
create policy "Users update own project assets" on storage.objects
for update to authenticated
using (
  bucket_id = 'project-assets'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'project-assets'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Users delete own project assets" on storage.objects;
create policy "Users delete own project assets" on storage.objects
for delete to authenticated
using (
  bucket_id = 'project-assets'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create index if not exists projects_user_id_idx on public.projects(user_id);
create index if not exists project_files_project_id_idx on public.project_files(project_id);
create index if not exists project_files_user_id_idx on public.project_files(user_id);
create index if not exists sections_project_id_idx on public.sections(project_id);
create index if not exists sections_file_id_idx on public.sections(file_id);
create index if not exists sections_user_id_idx on public.sections(user_id);
create index if not exists citations_project_id_idx on public.citations(project_id);
create index if not exists citations_user_id_idx on public.citations(user_id);
