begin;
create function public.storage_usage(p_owner uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare b storage_budget; used bigint; reserved bigint; queued bigint; listing jsonb; listing_reserved jsonb; listing_queued jsonb;
begin
 select * into b from storage_budget where id;
 select coalesce(sum(original_bytes+preview_bytes),0) into used from media where owner_id=p_owner;
 select coalesce(sum(original_bytes+preview_bytes),0) into reserved from upload_sessions where owner_id=p_owner and state not in ('complete','cancelled');
 select coalesce(sum(bytes),0) into queued from storage_gc where owner_id=p_owner;
 select coalesce(jsonb_object_agg(vehicle_id,bytes),'{}') into listing from (select vehicle_id,sum(original_bytes+preview_bytes) bytes from media where owner_id=p_owner group by vehicle_id) q;
 select coalesce(jsonb_object_agg(vehicle_id,bytes),'{}') into listing_reserved from (select vehicle_id,sum(original_bytes+preview_bytes) bytes from upload_sessions where owner_id=p_owner and state not in ('complete','cancelled') group by vehicle_id) q;
 select coalesce(jsonb_object_agg(vehicle_id,bytes),'{}') into listing_queued from (select vehicle_id,sum(bytes) bytes from storage_gc where owner_id=p_owner group by vehicle_id) q;
 return jsonb_build_object('usedBytes',used,'reservedBytes',reserved,'cleanupBytes',queued,'byListing',listing,'reservedByListing',listing_reserved,'cleanupByListing',listing_queued,
  'limits',jsonb_build_object('userBytes',b.user_limit_bytes,'listingBytes',b.listing_limit_bytes,'originalBytes',b.original_limit_bytes,'previewBytes',b.preview_limit_bytes),
  'uploadsAvailable',b.used_bytes+b.reserved_bytes<b.limit_bytes and used+reserved+queued<b.user_limit_bytes,
  'global',jsonb_build_object('usedBytes',b.used_bytes,'reservedBytes',b.reserved_bytes,'limitBytes',b.limit_bytes));
end $$;
revoke execute on function public.storage_usage(uuid) from public,anon,authenticated;
grant execute on function public.storage_usage(uuid) to service_role;
commit;
