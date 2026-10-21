begin;
-- Applied migrations 001–003 are intentionally unchanged. Legacy keys stay intact.
alter table public.media add column storage_provider text not null default 'r2' check(storage_provider in ('r2','cloudinary')),
 add column assets jsonb not null default '{}', add column signed_until timestamptz;
alter table public.upload_sessions add column storage_provider text not null default 'r2' check(storage_provider in ('r2','cloudinary')),
 add column assets jsonb not null default '{}', add column capacity_bytes bigint not null default 0;
update public.upload_sessions set capacity_bytes=original_bytes+preview_bytes;
alter table public.storage_gc add column storage_provider text not null default 'r2' check(storage_provider in ('r2','cloudinary')),
 add column assets jsonb not null default '{}';
alter table public.storage_budget add column cloudinary_raw_ceiling bigint not null default 10485760 check(cloudinary_raw_ceiling between 10485760 and 20971520);
update public.storage_budget set original_limit_bytes=least(original_limit_bytes,10000000),limit_bytes=case when used_bytes+reserved_bytes=0 then least(limit_bytes,2000000000) else limit_bytes end;
create table public.provider_status(id text primary key, snapshot jsonb not null default '{}', checked_at timestamptz not null default now());
alter table public.provider_status enable row level security;
revoke all on public.provider_status from public,anon,authenticated;
grant all on public.provider_status to service_role;

create function public.reserve_cloudinary_upload(p_owner uuid,p_vehicle uuid,p_id uuid,p_slot text,p_hash text,p_filename text,p_assets jsonb) returns public.upload_sessions language plpgsql security definer set search_path=public as $$
declare b storage_budget; v vehicles; s photo_slots; u upload_sessions; n integer; capacity bigint; total bigint; key text; item jsonb; original_size bigint; preview_size bigint;
begin
 select * into b from storage_budget where id for update;
 select * into v from vehicles where id=p_vehicle for update;
 if not found or v.owner_id<>p_owner or v.status='deleting' then raise exception 'Listing unavailable'; end if;
 select * into s from photo_slots where id=p_slot;
 if not found or (s.role='exterior' and mod(s.angle,360.0/v.frame_count)<>0) then raise exception 'Invalid photo slot'; end if;
 if jsonb_typeof(p_assets)<>'object' or not(p_assets?'original') then raise exception 'Original required'; end if;
 n:=0;
 for key,item in select * from jsonb_each(p_assets) loop
  if key not in ('original','preview','thumbnail') or item->>'key'<>'auto360/'||p_id::text||'/'||key||'.a360' or (item->>'sha256')!~'^[0-9a-f]{64}$' or (item->>'bytes')::bigint<1 then raise exception 'Invalid asset reservation'; end if;
  n:=n+1;
 end loop;
 if (p_assets?'preview')<>(p_assets?'thumbnail') then raise exception 'Preview and thumbnail must be uploaded together'; end if;
 original_size:=(p_assets->'original'->>'bytes')::bigint;
 preview_size:=coalesce((p_assets->'preview'->>'bytes')::bigint,0)+coalesce((p_assets->'thumbnail'->>'bytes')::bigint,0);
 if original_size>b.original_limit_bytes or original_size>b.cloudinary_raw_ceiling or preview_size>b.preview_limit_bytes then raise exception 'File exceeds configured Cloudinary Free limit; original was not changed'; end if;
 -- Signed uploads cannot restrict file size. Reserve the entire account raw-file ceiling
 -- for every issued signature, not the caller's declared byte count.
 capacity:=n*b.cloudinary_raw_ceiling;
 select coalesce(sum(bytes),0) into total from (
  select original_bytes+preview_bytes bytes from media where owner_id=p_owner
  union all select capacity_bytes from upload_sessions where owner_id=p_owner and state not in ('complete','cancelled')
  union all select bytes from storage_gc where owner_id=p_owner) q;
 if total+capacity>b.user_limit_bytes then raise exception 'Account storage headroom is insufficient for a secure direct-upload reservation'; end if;
 select coalesce(sum(bytes),0) into total from (
  select original_bytes+preview_bytes bytes from media where vehicle_id=p_vehicle
  union all select capacity_bytes from upload_sessions where vehicle_id=p_vehicle and state not in ('complete','cancelled')
  union all select bytes from storage_gc where vehicle_id=p_vehicle) q;
 if total+capacity>b.listing_limit_bytes or b.used_bytes+b.reserved_bytes+capacity>b.limit_bytes then raise exception 'Storage budget reached'; end if;
 if (select count(*) from upload_sessions where owner_id=p_owner and state not in ('complete','cancelled'))>=3 then raise exception 'Finish pending uploads first'; end if;
 insert into upload_sessions(id,vehicle_id,owner_id,slot_id,token_hash,original_key,preview_key,filename,original_bytes,preview_bytes,storage_provider,assets,capacity_bytes)
 values(p_id,p_vehicle,p_owner,p_slot,p_hash,p_assets->'original'->>'key','auto360/'||p_id::text||'/preview.a360',left(p_filename,200),original_size,preview_size,'cloudinary',p_assets,capacity) returning * into u;
 update storage_budget set reserved_bytes=reserved_bytes+capacity where id;
 return u;
end $$;

create function public.queue_provider_assets() returns trigger language plpgsql security definer set search_path=public as $$
declare m media; u upload_sessions;
begin
 if new.reserved then
  select * into u from upload_sessions where original_key=new.original_key;
  if found then new.storage_provider:=u.storage_provider;new.assets:=u.assets;new.bytes:=u.capacity_bytes; end if;
 else
  select * into m from media where original_key=new.original_key;
  if found then new.storage_provider:=m.storage_provider;new.assets:=m.assets;
   if m.storage_provider='cloudinary' then new.not_before:=greatest(new.not_before,coalesce(m.signed_until,now())+interval '24 hours'); end if;
  end if;
 end if;
 return new;
end $$;
create trigger gc_provider before insert on public.storage_gc for each row execute function public.queue_provider_assets();

create function public.complete_cloudinary_upload(p_owner uuid,p_id uuid,p_mime text,p_assets jsonb) returns uuid language plpgsql security definer set search_path=public as $$
declare u upload_sessions; old media; v vehicles; media_id uuid; key text; item jsonb;
begin
 perform 1 from storage_budget where id for update;
 select * into u from upload_sessions where id=p_id for update;
 if not found or u.owner_id<>p_owner or u.storage_provider<>'cloudinary' or u.state<>'finalizing' or u.expires_at<now() then raise exception 'Upload expired or unavailable'; end if;
 select * into v from vehicles where id=u.vehicle_id for update;
 if v.status='deleting' then raise exception 'Listing is being deleted'; end if;
 if (select count(*) from jsonb_object_keys(p_assets))<>(select count(*) from jsonb_object_keys(u.assets)) then raise exception 'Incomplete verification'; end if;
 for key,item in select * from jsonb_each(u.assets) loop
  if not(p_assets?key) or p_assets->key->>'key'<>item->>'key' or p_assets->key->>'sha256'<>item->>'sha256' or (p_assets->key->>'bytes')::bigint<>(item->>'bytes')::bigint or coalesce(p_assets->key->>'assetId','')='' then raise exception 'Asset verification mismatch'; end if;
 end loop;
 select * into old from media where vehicle_id=u.vehicle_id and slot_id=u.slot_id for update;
 if found then
  insert into storage_gc(owner_id,vehicle_id,original_key,preview_key,bytes) values(old.owner_id,old.vehicle_id,old.original_key,old.preview_key,old.original_bytes+old.preview_bytes);
  media_id:=old.id;
  update media set original_key=u.original_key,preview_key=case when u.preview_bytes>0 then u.preview_key end,filename=u.filename,mime=p_mime,original_bytes=u.original_bytes,preview_bytes=u.preview_bytes,sha256=u.assets->'original'->>'sha256',storage_provider='cloudinary',assets=p_assets,signed_until=u.created_at+interval '1 hour',created_at=now() where id=old.id;
 else
  media_id:=u.id;
  insert into media(id,vehicle_id,owner_id,slot_id,original_key,preview_key,filename,mime,original_bytes,preview_bytes,sha256,storage_provider,assets,signed_until)
  values(media_id,u.vehicle_id,p_owner,u.slot_id,u.original_key,case when u.preview_bytes>0 then u.preview_key end,u.filename,p_mime,u.original_bytes,u.preview_bytes,u.assets->'original'->>'sha256','cloudinary',p_assets,u.created_at+interval '1 hour');
 end if;
 update storage_budget set used_bytes=used_bytes+u.original_bytes+u.preview_bytes,reserved_bytes=reserved_bytes-u.capacity_bytes where id;
 update upload_sessions set state='complete',assets=p_assets where id=p_id;
 update vehicles set updated_at=now(),status=case when u.preview_bytes=0 and exists(select 1 from photo_slots where id=u.slot_id and required) then 'draft'::listing_status else status end where id=u.vehicle_id;
 return media_id;
end $$;

create or replace function public.storage_usage(p_owner uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare b storage_budget; used bigint; reserved bigint; queued bigint; listing jsonb; legacy bigint;
begin
 select * into b from storage_budget where id;
 select coalesce(sum(original_bytes+preview_bytes),0) into used from media where owner_id=p_owner;
 select coalesce(sum(capacity_bytes),0) into reserved from upload_sessions where owner_id=p_owner and state not in ('complete','cancelled');
 select coalesce(sum(bytes),0) into queued from storage_gc where owner_id=p_owner;
 select count(*) into legacy from media where owner_id=p_owner and storage_provider='r2';
 select coalesce(jsonb_object_agg(vehicle_id,bytes),'{}') into listing from(select vehicle_id,sum(original_bytes+preview_bytes) bytes from media where owner_id=p_owner group by vehicle_id) q;
 return jsonb_build_object('usedBytes',used,'reservedBytes',reserved,'cleanupBytes',queued,'byListing',listing,'legacyMediaCount',legacy,
 'limits',jsonb_build_object('userBytes',b.user_limit_bytes,'listingBytes',b.listing_limit_bytes,'originalBytes',b.original_limit_bytes,'previewBytes',b.preview_limit_bytes),
 'uploadsAvailable',b.used_bytes+b.reserved_bytes<b.limit_bytes and used+reserved+queued<b.user_limit_bytes,
 'reservedByListing',(select coalesce(jsonb_object_agg(vehicle_id,n),'{}') from(select vehicle_id,sum(capacity_bytes) n from upload_sessions where owner_id=p_owner and state not in ('complete','cancelled') group by vehicle_id) q),
 'cleanupByListing',(select coalesce(jsonb_object_agg(vehicle_id,n),'{}') from(select vehicle_id,sum(bytes) n from storage_gc where owner_id=p_owner group by vehicle_id) q),
 'global',jsonb_build_object('usedBytes',b.used_bytes,'reservedBytes',b.reserved_bytes,'limitBytes',b.limit_bytes),
 'accounting','Application-tracked bytes only. Cloudinary credits combine storage, bandwidth and transformations; inspect the Cloudinary dashboard for actual provider consumption.');
end $$;

create or replace function public.publish_vehicle(p_owner uuid,p_id uuid,p_publish boolean) returns text language plpgsql security definer set search_path=public as $$
declare v vehicles; d jsonb;
begin
 perform 1 from storage_budget where id for update;
 select * into v from vehicles where id=p_id for update;
 if not found or v.owner_id<>p_owner or v.status='deleting' then raise exception 'Listing unavailable'; end if;
 if p_publish then
  if exists(select 1 from media where vehicle_id=p_id and storage_provider<>'cloudinary') then raise exception 'Transfer all legacy R2 photos before publishing on Cloudinary'; end if;
  select details into d from vehicle_specifications where vehicle_id=p_id;
  if coalesce(trim(d->>'make'),'')='' or coalesce(trim(d->>'model'),'')='' or coalesce(d->>'year','')='' then raise exception 'Complete car essentials before publishing'; end if;
  if exists(select 1 from photo_slots s where s.required and (s.role<>'exterior' or mod(s.angle,360.0/v.frame_count)=0) and not exists(select 1 from media m where m.vehicle_id=p_id and m.slot_id=s.id and m.preview_bytes>0 and m.storage_provider='cloudinary')) then raise exception 'Every required position needs a verified preview before publishing'; end if;
 end if;
 update vehicles set status=case when p_publish then 'published'::listing_status else 'draft'::listing_status end,published_at=case when p_publish then now() end,updated_at=now() where id=p_id;
 return v.slug;
end $$;
revoke execute on function public.reserve_cloudinary_upload(uuid,uuid,uuid,text,text,text,jsonb),public.queue_provider_assets(),public.complete_cloudinary_upload(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_cloudinary_upload(uuid,uuid,uuid,text,text,text,jsonb),public.complete_cloudinary_upload(uuid,uuid,text,jsonb) to service_role;
commit;
