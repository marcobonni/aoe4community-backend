create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  display_name text not null,
  role text not null default 'user',
  discord_name text,
  steam_name text,
  avatar_url text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint profiles_role_check check (role in ('user', 'admin'))
);

create table if not exists public.tournaments (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null unique,
  description text not null default '',
  banner_url text,
  status text not null default 'draft',
  format text not null default 'single_elimination',
  participant_mode text not null default '1v1',
  signup_mode text not null default 'public',
  visibility text not null default 'public',
  seeding_mode text not null default 'manual',
  best_of integer not null default 3,
  requires_check_in boolean not null default false,
  scheduling_mode text not null default 'deadline',
  tie_breaker text not null default 'head_to_head',
  map_rules text not null default '',
  prize_summary text not null default '',
  notes text not null default '',
  result_confirmation_mode text not null default 'dual_confirmation',
  evidence_mode text not null default 'optional',
  max_participants integer not null default 8,
  min_participants integer not null default 2,
  starts_at timestamptz,
  registration_opens_at timestamptz,
  registration_closes_at timestamptz,
  bracket_generated_at timestamptz,
  created_by_profile_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint tournaments_best_of_check check (best_of >= 1 and mod(best_of, 2) = 1),
  constraint tournaments_participants_check check (
    min_participants >= 2 and max_participants >= min_participants
  )
);

create table if not exists public.tournament_registrations (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  seed integer,
  status text not null default 'pending',
  source text not null default 'signup',
  requested_at timestamptz not null default timezone('utc', now()),
  approved_at timestamptz,
  approved_by_profile_id uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default timezone('utc', now()),
  constraint tournament_registrations_unique unique (tournament_id, user_id)
);

create table if not exists public.tournament_matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  round_number integer not null,
  match_number integer not null,
  player1_id uuid references public.profiles(id) on delete set null,
  player2_id uuid references public.profiles(id) on delete set null,
  winner_id uuid references public.profiles(id) on delete set null,
  pending_winner_id uuid references public.profiles(id) on delete set null,
  status text not null default 'pending',
  next_match_id uuid references public.tournament_matches(id) on delete set null,
  next_match_slot integer,
  player1_wins integer,
  player2_wins integer,
  reported_by_id uuid references public.profiles(id) on delete set null,
  confirmed_by_id uuid references public.profiles(id) on delete set null,
  report_evidence text,
  dispute_reason text,
  admin_notes text,
  resolution_type text,
  reported_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint tournament_matches_unique unique (tournament_id, round_number, match_number),
  constraint tournament_matches_slot_check check (next_match_slot in (1, 2) or next_match_slot is null)
);

create index if not exists idx_tournament_registrations_tournament
  on public.tournament_registrations (tournament_id);

create index if not exists idx_tournament_registrations_user
  on public.tournament_registrations (user_id);

create index if not exists idx_tournament_matches_tournament
  on public.tournament_matches (tournament_id);

create index if not exists idx_tournament_matches_players
  on public.tournament_matches (player1_id, player2_id);

alter table public.profiles
add column if not exists role text not null default 'user';

alter table public.profiles
drop constraint if exists profiles_role_check;

alter table public.profiles
add constraint profiles_role_check check (role in ('user', 'admin'));
