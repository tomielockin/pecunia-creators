-- =====================================================================
--  PECUNIA · Plateforme créateurs — Schéma Supabase
--  À coller dans Supabase : SQL Editor → New query → Run.
--  Idempotent : tu peux le relancer sans casser l'existant.
-- =====================================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ --
--  TABLES
-- ------------------------------------------------------------------ --

-- Profils (1 par utilisateur connecté). role = 'admin' | 'creator'.
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        text not null default 'creator' check (role in ('admin','creator')),
  name        text,
  handle      text,
  rate        numeric,        -- € / 1000 vues (null = barème par défaut)
  cap         numeric,        -- plafond € / vidéo (null = barème par défaut)
  approved    boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Vidéos déposées par les créateurs.
create table if not exists public.videos (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references public.profiles(id) on delete cascade,
  platform    text not null default 'autre',
  url         text not null,
  title       text,
  angle       text check (angle in ('A','B','C','D')),
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_videos_creator on public.videos(creator_id);

-- Relevés de vues, 1 ligne par vidéo et par mois ('YYYY-MM').
create table if not exists public.readings (
  id            uuid primary key default gen_random_uuid(),
  video_id      uuid not null references public.videos(id) on delete cascade,
  month         text not null,
  declared      integer,
  validated     integer,
  status        text not null default 'declared' check (status in ('declared','validated')),
  paid          boolean not null default false,
  declared_at   timestamptz,
  validated_at  timestamptz,
  paid_at       timestamptz,
  unique (video_id, month)
);
create index if not exists idx_readings_video on public.readings(video_id);

-- Réglages globaux (ligne unique id = 1).
create table if not exists public.app_config (
  id            integer primary key default 1 check (id = 1),
  rpm_rate      numeric not null default 1,
  cap           numeric not null default 200,
  declare_open  integer not null default 25,
  declare_close integer not null default 28,
  pay_day       integer not null default 30
);
insert into public.app_config (id) values (1) on conflict (id) do nothing;

-- ------------------------------------------------------------------ --
--  HELPERS
-- ------------------------------------------------------------------ --

-- Vrai si l'utilisateur courant est admin. security definer => pas de récursion RLS.
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- À la création d'un compte auth, on crée son profil (créateur, non approuvé).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, role, approved)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', new.email), 'creator', false)
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------------ --
--  RLS (Row Level Security)
-- ------------------------------------------------------------------ --

alter table public.profiles   enable row level security;
alter table public.videos     enable row level security;
alter table public.readings   enable row level security;
alter table public.app_config enable row level security;

-- profiles : on lit son propre profil, l'admin lit tout ; l'admin seul modifie.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

-- videos : le créateur gère les siennes (s'il est approuvé), l'admin voit/gère tout.
drop policy if exists videos_select on public.videos;
create policy videos_select on public.videos
  for select using (creator_id = auth.uid() or public.is_admin());
drop policy if exists videos_insert on public.videos;
create policy videos_insert on public.videos
  for insert with check (
    creator_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.approved)
  );
drop policy if exists videos_update on public.videos;
create policy videos_update on public.videos
  for update using (creator_id = auth.uid() or public.is_admin())
  with check (creator_id = auth.uid() or public.is_admin());
drop policy if exists videos_delete on public.videos;
create policy videos_delete on public.videos
  for delete using (creator_id = auth.uid() or public.is_admin());

-- readings : lecture des siennes (ou tout pour l'admin). Écritures : via RPC uniquement
-- pour les créateurs ; l'admin a un accès direct complet.
drop policy if exists readings_select on public.readings;
create policy readings_select on public.readings
  for select using (
    public.is_admin()
    or video_id in (select id from public.videos where creator_id = auth.uid())
  );
drop policy if exists readings_admin_all on public.readings;
create policy readings_admin_all on public.readings
  for all using (public.is_admin()) with check (public.is_admin());

-- app_config : lisible par tout connecté, modifiable par l'admin.
drop policy if exists config_select on public.app_config;
create policy config_select on public.app_config
  for select using (auth.uid() is not null);
drop policy if exists config_update on public.app_config;
create policy config_update on public.app_config
  for update using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------------ --
--  RPC (transitions sensibles, contrôlées côté serveur)
-- ------------------------------------------------------------------ --

-- Le créateur déclare le total de vues du mois (cumul). N'écrase jamais un mois validé.
create or replace function public.declare_views(p_video uuid, p_month text, p_views integer)
returns void language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_validated boolean;
begin
  select creator_id into v_owner from public.videos where id = p_video;
  if v_owner is null then raise exception 'Vidéo introuvable'; end if;
  if v_owner <> auth.uid() and not public.is_admin() then
    raise exception 'Action non autorisée';
  end if;
  select (status = 'validated') into v_validated
    from public.readings where video_id = p_video and month = p_month;
  if coalesce(v_validated,false) and not public.is_admin() then
    raise exception 'Ce mois est déjà validé';
  end if;
  insert into public.readings (video_id, month, declared, validated, status, declared_at)
  values (p_video, p_month, p_views, p_views, 'declared', now())
  on conflict (video_id, month) do update
    set declared = excluded.declared,
        validated = excluded.declared,
        status = 'declared',
        declared_at = now();
end; $$;

-- L'admin valide (fige) le total de vues payé pour un mois.
create or replace function public.validate_reading(p_video uuid, p_month text, p_views integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''admin'; end if;
  insert into public.readings (video_id, month, declared, validated, status, validated_at)
  values (p_video, p_month, p_views, p_views, 'validated', now())
  on conflict (video_id, month) do update
    set validated = excluded.validated,
        status = 'validated',
        validated_at = now();
end; $$;

-- L'admin solde un créateur : marque payés tous ses relevés validés non encore payés,
-- avec une date de versement choisie (p_date, par défaut maintenant) pour le suivi compta.
drop function if exists public.mark_creator_paid(uuid);
create or replace function public.mark_creator_paid(p_creator uuid, p_date timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''admin'; end if;
  update public.readings r set paid = true, paid_at = p_date
  from public.videos v
  where r.video_id = v.id
    and v.creator_id = p_creator
    and r.status = 'validated'
    and r.paid = false;
end; $$;

-- L'admin supprime un créateur : supprime son compte auth -> cascade profil/vidéos/relevés.
create or replace function public.delete_creator(p_creator uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''admin'; end if;
  delete from auth.users where id = p_creator;
end; $$;

-- Supprime une déclaration (relevé) d'une vidéo pour un mois.
-- Admin : toujours. Créateur : seulement les siennes et pas encore validées.
create or replace function public.delete_reading(p_video uuid, p_month text)
returns void language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_status text;
begin
  select creator_id into v_owner from public.videos where id = p_video;
  if v_owner is null then raise exception 'Vidéo introuvable'; end if;
  select status into v_status from public.readings where video_id = p_video and month = p_month;
  if public.is_admin() then
    delete from public.readings where video_id = p_video and month = p_month;
  elsif v_owner = auth.uid() then
    if coalesce(v_status,'declared') = 'validated' then
      raise exception 'Déclaration déjà validée : demande à l''admin de la retirer';
    end if;
    delete from public.readings where video_id = p_video and month = p_month;
  else
    raise exception 'Action non autorisée';
  end if;
end; $$;

-- ------------------------------------------------------------------ --
--  GRANTS
-- ------------------------------------------------------------------ --

grant usage on schema public to anon, authenticated;
grant select                              on public.app_config to authenticated;
grant update                              on public.app_config to authenticated; -- borné par RLS (admin)
grant select, update                      on public.profiles   to authenticated; -- update borné par RLS (admin)
grant select, insert, update, delete      on public.videos     to authenticated;
grant select                              on public.readings   to authenticated; -- écritures via RPC
grant execute on function public.is_admin()                              to authenticated;
grant execute on function public.declare_views(uuid, text, integer)      to authenticated;
grant execute on function public.validate_reading(uuid, text, integer)   to authenticated;
grant execute on function public.mark_creator_paid(uuid, timestamptz)    to authenticated;
grant execute on function public.delete_creator(uuid)                    to authenticated;
grant execute on function public.delete_reading(uuid, text)              to authenticated;

-- =====================================================================
--  APRÈS EXÉCUTION : crée ton compte admin (voir README), puis lance :
--    update public.profiles set role = 'admin', approved = true
--    where id = (select id from auth.users where email = 'TON_EMAIL');
-- =====================================================================
