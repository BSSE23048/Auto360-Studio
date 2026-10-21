begin;
create type public.listing_status as enum ('draft','published','deleting');
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null default '' check (length(display_name)<=100),
  created_at timestamptz not null default now()
);
create function public.new_profile() returns trigger language plpgsql security definer set search_path=public as $$
begin insert into profiles(id,display_name) values(new.id,left(coalesce(new.raw_user_meta_data->>'name',''),100)); return new; end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.new_profile();
create table public.vehicles (
  id uuid primary key, owner_id uuid not null references auth.users,
  slug text not null unique default left(replace(gen_random_uuid()::text,'-',''),30),
  status public.listing_status not null default 'draft',
  frame_count integer not null default 24 check(frame_count in (24,48)),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), published_at timestamptz
);
create index vehicles_owner_updated on public.vehicles(owner_id,updated_at desc);
create index vehicles_published on public.vehicles(slug) where status='published';
create table public.vehicle_specifications (
  vehicle_id uuid primary key references public.vehicles on delete cascade,
  details jsonb not null default '{}' check(jsonb_typeof(details)='object' and octet_length(details::text)<16000)
);
create table public.media_roles (id text primary key);
insert into public.media_roles values('exterior'),('inspection'),('extra');
create table public.photo_slots (
  id text primary key, role text not null references public.media_roles, ordinal integer not null unique,
  angle numeric, required boolean not null default false,
  check(angle is null or (angle>=0 and angle<360))
);
insert into public.photo_slots select 'ext-'||(i*7.5)::double precision::text,'exterior',i,i*7.5,true from generate_series(0,47) i;
insert into public.photo_slots(id,role,ordinal,required) values
 ('engine','inspection',100,true),('trunk','inspection',101,true),('front-interior','inspection',102,true),('rear-interior','inspection',103,true),('odometer','inspection',104,true),('wheel','inspection',105,true),
 ('scratches','extra',200,false),('paint','extra',201,false),('door-fl','extra',202,false),('door-fr','extra',203,false),('door-rl','extra',204,false),('door-rr','extra',205,false),('service','extra',206,false),('other','extra',207,false);
create table public.condition_notes (
  id uuid primary key default gen_random_uuid(), vehicle_id uuid not null references public.vehicles on delete cascade,
  slot_id text references public.photo_slots, note text not null check(length(note)<=2000), created_at timestamptz not null default now()
);
create table public.media (
  id uuid primary key, vehicle_id uuid not null references public.vehicles on delete cascade,
  owner_id uuid not null references auth.users, slot_id text not null references public.photo_slots,
  original_key text not null unique, preview_key text unique, filename text not null check(length(filename)<=200),
  mime text not null, original_bytes bigint not null check(original_bytes>0), preview_bytes bigint not null default 0 check(preview_bytes>=0),
  sha256 text not null check(length(sha256)=64), created_at timestamptz not null default now(),
  unique(vehicle_id,slot_id), check((preview_key is null)=(preview_bytes=0))
);
create index media_owner on public.media(owner_id);
create table public.storage_budget (
  id boolean primary key default true check(id), used_bytes bigint not null default 0 check(used_bytes>=0),
  reserved_bytes bigint not null default 0 check(reserved_bytes>=0),
  -- 8 GB cap, including previews and pending uploads; 2 GB retained as external headroom.
  limit_bytes bigint not null default 8000000000 check(limit_bytes between 1000000 and 8000000000),
  user_limit_bytes bigint not null default 500000000 check(user_limit_bytes>0),
  listing_limit_bytes bigint not null default 250000000 check(listing_limit_bytes>0),
  original_limit_bytes bigint not null default 20000000 check(original_limit_bytes between 1 and 20000000),
  preview_limit_bytes bigint not null default 1048576 check(preview_limit_bytes between 1 and 1048576)
);
insert into public.storage_budget(id) values(true);
create table public.upload_sessions (
  id uuid primary key, vehicle_id uuid not null references public.vehicles, owner_id uuid not null references auth.users,
  slot_id text not null references public.photo_slots, token_hash text not null,
  original_key text not null unique, preview_key text not null unique, filename text not null,
  original_bytes bigint not null check(original_bytes>0), preview_bytes bigint not null check(preview_bytes>=0),
  state text not null default 'initiated' check(state in ('initiated','writing-original','original-ready','writing-preview','ready','finalizing','complete','cancelled')),
  expires_at timestamptz not null default now()+interval '15 minutes', created_at timestamptz not null default now()
);
create unique index upload_one_slot on public.upload_sessions(vehicle_id,slot_id) where state not in ('complete','cancelled');
create index upload_expiry on public.upload_sessions(expires_at) where state not in ('complete','cancelled');
create table public.storage_gc (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, vehicle_id uuid not null,
  original_key text not null, preview_key text, bytes bigint not null check(bytes>=0),
  -- Reservations remain charged until late/in-flight writes can no longer occur.
  reserved boolean not null default false, not_before timestamptz not null default now(), created_at timestamptz not null default now()
);
create index gc_due on public.storage_gc(not_before);
create table public.api_rate_limits (key text primary key, window_start timestamptz not null, hits integer not null);

alter table public.profiles enable row level security;
alter table public.vehicles enable row level security;
alter table public.vehicle_specifications enable row level security;
alter table public.condition_notes enable row level security;
alter table public.media enable row level security;
alter table public.media_roles enable row level security;
alter table public.photo_slots enable row level security;
alter table public.storage_budget enable row level security;
alter table public.upload_sessions enable row level security;
alter table public.storage_gc enable row level security;
alter table public.api_rate_limits enable row level security;
create policy own_profile on public.profiles for select to authenticated using(id=auth.uid());
create policy own_vehicle on public.vehicles for select to authenticated using(owner_id=auth.uid() and status<>'deleting');
create policy own_specs on public.vehicle_specifications for select to authenticated using(exists(select 1 from public.vehicles v where v.id=vehicle_id and v.owner_id=auth.uid()));
create policy own_notes on public.condition_notes for select to authenticated using(exists(select 1 from public.vehicles v where v.id=vehicle_id and v.owner_id=auth.uid()));
create policy own_media on public.media for select to authenticated using(owner_id=auth.uid());
-- All mutations pass through the Worker; direct browser writes have no policies.
revoke all on public.profiles,public.vehicles,public.vehicle_specifications,public.condition_notes,public.media,public.media_roles,public.photo_slots,public.storage_budget,public.upload_sessions,public.storage_gc,public.api_rate_limits from anon,authenticated;
grant select on public.profiles,public.vehicles,public.vehicle_specifications,public.condition_notes,public.media to authenticated;
grant all on public.profiles,public.vehicles,public.vehicle_specifications,public.condition_notes,public.media,public.media_roles,public.photo_slots,public.storage_budget,public.upload_sessions,public.storage_gc,public.api_rate_limits to service_role;
commit;
