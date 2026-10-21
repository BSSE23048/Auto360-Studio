begin;
-- Metadata-only reassignment preserves original keys, bytes, IDs and quota charges.
create function public.assign_photo_slot(p_owner uuid,p_vehicle uuid,p_media uuid,p_slot text)
returns void language plpgsql security definer set search_path=public as $$
declare v vehicles; source media; target media; destination photo_slots;
begin
 perform 1 from storage_budget where id for update;
 select * into v from vehicles where id=p_vehicle for update;
 if not found or v.owner_id<>p_owner or v.status='deleting' then raise exception 'Listing unavailable'; end if;
 select * into source from media where id=p_media and vehicle_id=p_vehicle and owner_id=p_owner for update;
 if not found then raise exception 'Photo unavailable'; end if;
 select * into destination from photo_slots where id=p_slot;
 if not found or (destination.role='exterior' and mod(destination.angle,360.0/v.frame_count)<>0) then raise exception 'Invalid photo slot'; end if;
 if source.slot_id=p_slot then return; end if;
 if exists(select 1 from upload_sessions where vehicle_id=p_vehicle and state not in ('complete','cancelled')) then raise exception 'Finish or cancel pending uploads before changing photo positions'; end if;
 -- Hold the destination record transactionally to satisfy the immediate unique constraint.
 -- Reinsert its same ID and assets; no provider deletion or cleanup is performed.
 delete from media where vehicle_id=p_vehicle and slot_id=p_slot returning * into target;
 update media set slot_id=p_slot where id=source.id;
 if target.id is not null then
  target.slot_id:=source.slot_id;
  insert into media select (target).*;
 end if;
 update vehicles set status='draft',published_at=null,updated_at=now() where id=p_vehicle;
end $$;
revoke execute on function public.assign_photo_slot(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.assign_photo_slot(uuid,uuid,uuid,text) to service_role;
commit;
