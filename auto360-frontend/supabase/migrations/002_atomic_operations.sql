begin;
create function public.api_rate(p_key text,p_limit integer) returns boolean language plpgsql security definer set search_path=public as $$
declare n integer;
begin
 insert into api_rate_limits values(p_key,date_trunc('minute',now()),1)
 on conflict(key) do update set hits=case when api_rate_limits.window_start<date_trunc('minute',now()) then 1 else api_rate_limits.hits+1 end,window_start=date_trunc('minute',now()) returning hits into n;
 return n<=p_limit;
end $$;

create function public.save_vehicle(p_owner uuid,p_id uuid,p_frames integer,p_details jsonb) returns void language plpgsql security definer set search_path=public as $$
declare v vehicles; begin
 perform 1 from storage_budget where id for update;
 select * into v from vehicles where id=p_id for update;
 if found then
  if v.owner_id<>p_owner or v.status='deleting' then raise exception 'Listing unavailable'; end if;
  if v.frame_count<>p_frames then raise exception 'Capture plan cannot change after creation'; end if;
  update vehicles set updated_at=now() where id=p_id;
 else
  if (select count(*) from vehicles where owner_id=p_owner)>=10 then raise exception 'Maximum 10 listings per account'; end if;
  insert into vehicles(id,owner_id,frame_count) values(p_id,p_owner,p_frames);
 end if;
 insert into vehicle_specifications values(p_id,p_details) on conflict(vehicle_id) do update set details=excluded.details;
end $$;

create function public.reserve_upload(p_owner uuid,p_vehicle uuid,p_id uuid,p_slot text,p_hash text,p_original_key text,p_preview_key text,p_filename text,p_bytes bigint,p_preview bigint) returns void language plpgsql security definer set search_path=public as $$
declare b storage_budget; v vehicles; total bigint; user_total bigint; listing_total bigint; s photo_slots;
begin
 select * into b from storage_budget where id for update;
 select * into v from vehicles where id=p_vehicle for update;
 if not found or v.owner_id<>p_owner or v.status='deleting' then raise exception 'Listing unavailable'; end if;
 select * into s from photo_slots where id=p_slot;
 if not found or (s.role='exterior' and mod(s.angle,360.0/v.frame_count)<>0) then raise exception 'Invalid photo slot'; end if;
 if p_bytes<1 or p_bytes>b.original_limit_bytes or p_preview<0 or p_preview>b.preview_limit_bytes then raise exception 'File exceeds configured size limit'; end if;
 total:=p_bytes+p_preview;
 select coalesce(sum(n),0) into user_total from (
  select original_bytes+preview_bytes n from media where owner_id=p_owner
  union all select original_bytes+preview_bytes from upload_sessions where owner_id=p_owner and state not in ('complete','cancelled')
  union all select bytes from storage_gc where owner_id=p_owner
 ) q;
 select coalesce(sum(n),0) into listing_total from (
  select original_bytes+preview_bytes n from media where vehicle_id=p_vehicle
  union all select original_bytes+preview_bytes from upload_sessions where vehicle_id=p_vehicle and state not in ('complete','cancelled')
  union all select bytes from storage_gc where vehicle_id=p_vehicle
 ) q;
 if b.used_bytes+b.reserved_bytes+total>b.limit_bytes or user_total+total>b.user_limit_bytes or listing_total+total>b.listing_limit_bytes then raise exception 'Storage budget reached; remove content and wait for cleanup'; end if;
 if (select count(*) from upload_sessions where owner_id=p_owner and state not in ('complete','cancelled'))>=3 then raise exception 'Finish or cancel pending uploads first'; end if;
 insert into upload_sessions(id,vehicle_id,owner_id,slot_id,token_hash,original_key,preview_key,filename,original_bytes,preview_bytes)
 values(p_id,p_vehicle,p_owner,p_slot,p_hash,p_original_key,p_preview_key,left(p_filename,200),p_bytes,p_preview);
 update storage_budget set reserved_bytes=reserved_bytes+total where id;
end $$;

create function public.complete_upload(p_owner uuid,p_id uuid,p_mime text,p_sha text,p_bytes bigint,p_preview bigint) returns void language plpgsql security definer set search_path=public as $$
declare u upload_sessions; old media; v vehicles;
begin
 perform 1 from storage_budget where id for update;
 select * into u from upload_sessions where id=p_id for update;
 if not found or u.owner_id<>p_owner or u.state<>'finalizing' or u.expires_at<now() then raise exception 'Upload expired or unavailable'; end if;
 select * into v from vehicles where id=u.vehicle_id for update;
 if v.status='deleting' then raise exception 'Listing is being deleted'; end if;
 if p_bytes<>u.original_bytes or p_preview<>u.preview_bytes then raise exception 'Stored size does not match reservation'; end if;
 select * into old from media where vehicle_id=u.vehicle_id and slot_id=u.slot_id for update;
 if found then
  insert into storage_gc(owner_id,vehicle_id,original_key,preview_key,bytes) values(old.owner_id,old.vehicle_id,old.original_key,old.preview_key,old.original_bytes+old.preview_bytes);
  delete from media where id=old.id;
 end if;
 insert into media(id,vehicle_id,owner_id,slot_id,original_key,preview_key,filename,mime,original_bytes,preview_bytes,sha256)
 values(u.id,u.vehicle_id,p_owner,u.slot_id,u.original_key,case when p_preview>0 then u.preview_key end,u.filename,p_mime,p_bytes,p_preview,p_sha);
 update storage_budget set used_bytes=used_bytes+p_bytes+p_preview,reserved_bytes=reserved_bytes-u.original_bytes-u.preview_bytes where id;
 update upload_sessions set state='complete' where id=p_id;
 update vehicles set updated_at=now(),
  status=case when p_preview=0 and exists(select 1 from photo_slots where id=u.slot_id and required) then 'draft'::listing_status else status end,
  published_at=case when p_preview=0 and exists(select 1 from photo_slots where id=u.slot_id and required) then null else published_at end
 where id=u.vehicle_id;
end $$;

create function public.cancel_upload(p_owner uuid,p_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare u upload_sessions; begin
 perform 1 from storage_budget where id for update;
 select * into u from upload_sessions where id=p_id for update;
 if not found or u.owner_id<>p_owner then raise exception 'Upload unavailable'; end if;
 if u.state in ('complete','cancelled') then return; end if;
 insert into storage_gc(owner_id,vehicle_id,original_key,preview_key,bytes,reserved,not_before)
 values(u.owner_id,u.vehicle_id,u.original_key,u.preview_key,u.original_bytes+u.preview_bytes,true,greatest(now(),u.expires_at)+interval '24 hours');
 update upload_sessions set state='cancelled' where id=p_id;
end $$;

create function public.remove_media(p_owner uuid,p_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare m media; begin
 perform 1 from storage_budget where id for update;
 select * into m from media where id=p_id for update;
 if not found or m.owner_id<>p_owner then raise exception 'Photo unavailable'; end if;
 insert into storage_gc(owner_id,vehicle_id,original_key,preview_key,bytes) values(m.owner_id,m.vehicle_id,m.original_key,m.preview_key,m.original_bytes+m.preview_bytes);
 delete from media where id=p_id;
 update vehicles set status='draft',published_at=null,updated_at=now() where id=m.vehicle_id;
end $$;

create function public.delete_vehicle(p_owner uuid,p_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare u upload_sessions; v vehicles; begin
 perform 1 from storage_budget where id for update;
 select * into v from vehicles where id=p_id for update;
 if not found or v.owner_id<>p_owner then raise exception 'Listing unavailable'; end if;
 update vehicles set status='deleting',published_at=null where id=p_id;
 for u in select * from upload_sessions where vehicle_id=p_id and state not in ('complete','cancelled') loop perform cancel_upload(p_owner,u.id); end loop;
 insert into storage_gc(owner_id,vehicle_id,original_key,preview_key,bytes) select owner_id,vehicle_id,original_key,preview_key,original_bytes+preview_bytes from media where vehicle_id=p_id;
 delete from media where vehicle_id=p_id;
 if not exists(select 1 from storage_gc where vehicle_id=p_id) then
  delete from upload_sessions where vehicle_id=p_id and state in ('complete','cancelled');
  delete from vehicles where id=p_id;
 end if;
end $$;

create function public.publish_vehicle(p_owner uuid,p_id uuid,p_publish boolean) returns text language plpgsql security definer set search_path=public as $$
declare v vehicles; d jsonb; begin
 perform 1 from storage_budget where id for update;
 select * into v from vehicles where id=p_id for update;
 if not found or v.owner_id<>p_owner or v.status='deleting' then raise exception 'Listing unavailable'; end if;
 if p_publish then
  select details into d from vehicle_specifications where vehicle_id=p_id;
  if coalesce(trim(d->>'make'),'')='' or coalesce(trim(d->>'model'),'')='' or coalesce(d->>'year','')='' then raise exception 'Complete car essentials before publishing'; end if;
  if exists(select 1 from photo_slots s where s.required and (s.role<>'exterior' or mod(s.angle,360.0/v.frame_count)=0) and not exists(select 1 from media m where m.vehicle_id=p_id and m.slot_id=s.id and m.preview_bytes>0)) then raise exception 'Every required position needs a browser-compatible preview before publishing'; end if;
 end if;
 update vehicles set status=case when p_publish then 'published'::listing_status else 'draft'::listing_status end,published_at=case when p_publish then now() end,updated_at=now() where id=p_id;
 return v.slug;
end $$;

create function public.finish_gc(p_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare g storage_gc; begin
 perform 1 from storage_budget where id for update;
 delete from storage_gc where id=p_id and not_before<=now() returning * into g;
 if not found then return; end if;
 if g.reserved then update storage_budget set reserved_bytes=reserved_bytes-g.bytes where id;
 else update storage_budget set used_bytes=used_bytes-g.bytes where id; end if;
 delete from upload_sessions where state in ('complete','cancelled') and vehicle_id=g.vehicle_id;
 delete from vehicles where id=g.vehicle_id and status='deleting' and not exists(select 1 from storage_gc where vehicle_id=g.vehicle_id) and not exists(select 1 from upload_sessions where vehicle_id=g.vehicle_id);
end $$;
-- RPCs contain privileged operations: only the Worker service role may execute them.
revoke execute on function public.new_profile(),public.api_rate(text,integer),public.save_vehicle(uuid,uuid,integer,jsonb),public.reserve_upload(uuid,uuid,uuid,text,text,text,text,text,bigint,bigint),public.complete_upload(uuid,uuid,text,text,bigint,bigint),public.cancel_upload(uuid,uuid),public.remove_media(uuid,uuid),public.delete_vehicle(uuid,uuid),public.publish_vehicle(uuid,uuid,boolean),public.finish_gc(uuid) from public,anon,authenticated;
grant execute on function public.api_rate(text,integer),public.save_vehicle(uuid,uuid,integer,jsonb),public.reserve_upload(uuid,uuid,uuid,text,text,text,text,text,bigint,bigint),public.complete_upload(uuid,uuid,text,text,bigint,bigint),public.cancel_upload(uuid,uuid),public.remove_media(uuid,uuid),public.delete_vehicle(uuid,uuid),public.publish_vehicle(uuid,uuid,boolean),public.finish_gc(uuid) to service_role;
commit;
