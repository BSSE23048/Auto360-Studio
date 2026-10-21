import { admin, download, inventory, destroy, signedUpload, verifiedBytes, imageDimensions, CloudinaryError, type CloudinaryEnv, type AssetPlans } from './cloudinary';
interface Env extends CloudinaryEnv { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string; SUPABASE_ANON_KEY: string; ALLOWED_ORIGINS: string; FRONTEND_ORIGIN: string }
interface Vehicle { id: string; owner_id: string; slug: string; status: string; frame_count: 24 | 48; created_at: string; updated_at: string; vehicle_specifications: { details: Record<string, string> } | null }
interface Media { id: string; owner_id: string; vehicle_id: string; slot_id: string; original_key: string; preview_key: string | null; filename: string; mime: string; original_bytes: number; preview_bytes: number; sha256: string; created_at: string; storage_provider: string; assets: AssetPlans }
interface Upload { id: string; vehicle_id: string; owner_id: string; slot_id: string; token_hash: string; original_key: string; preview_key: string; filename: string; original_bytes: number; preview_bytes: number; state: string; expires_at: string; created_at: string; storage_provider: string; assets: AssetPlans }
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slugPattern = /^[0-9a-f]{30}$/;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
function id(value: string): string { if (!uuid.test(value)) throw new HttpError(400, 'Invalid identifier'); return value; }
function required(value: unknown, max = 200): string { if (typeof value !== 'string' || !value || value.length > max) throw new HttpError(400, 'Invalid text value'); return value; }
async function hash(bytes: ArrayBuffer | Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join(''); }
const hashText = (value: string) => hash(new TextEncoder().encode(value));

async function db<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const headers=new Headers(init.headers);headers.set('apikey',env.SUPABASE_SERVICE_ROLE_KEY);headers.set('Authorization',`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);headers.set('Content-Type','application/json');if(!headers.has('Prefer'))headers.set('Prefer','return=representation');
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init, headers,
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { code?: string; message?: string };
    if (detail.code === 'P0001') throw new HttpError(409, detail.message || 'Operation rejected');
    if (detail.code === '23505') throw new HttpError(409, 'An upload for this slot is already active. Finish it or wait for expiry.');
    throw new HttpError(503, 'Database operation unavailable. Retry shortly.');
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
const rpc = <T>(env: Env, name: string, body: object) => db<T>(env, `rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
async function authenticate(request: Request, env: Env): Promise<string> {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ') || authorization.length > 8192) throw new HttpError(401, 'Please sign in.');
  // Validate with Supabase Auth; never trust decoded but unverified JWT claims.
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authorization } });
  if (!response.ok) throw new HttpError(401, 'Your session has expired. Please sign in.');
  const user = await response.json() as { id?: string };
  if (!user.id || !uuid.test(user.id)) throw new HttpError(401, 'Invalid session');
  return user.id;
}
async function limit(env: Env, key: string, count: number) {
  if (!await rpc<boolean>(env, 'api_rate', { p_key: key, p_limit: count })) throw new HttpError(429, 'Too many requests. Wait one minute and try again.');
}
async function boundedBody(request: Request | Response, maximum: number): Promise<Uint8Array> {
  const length = Number(request.headers.get('Content-Length'));
  if (length > maximum) throw new HttpError(413, 'File exceeds reserved upload size');
  if (!request.body) throw new HttpError(400, 'Request body is required');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const deadline = Date.now() + 60000;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(408, 'Upload timed out')), Math.max(1, deadline - Date.now())); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximum) throw new HttpError(413, 'File exceeds reserved upload size');
      chunks.push(result.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const combined = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return combined;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  try { const parsed: unknown = JSON.parse(new TextDecoder().decode(await boundedBody(request, 20000))); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(); return parsed as Record<string, unknown>; }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid JSON body'); }
}
function sniff(bytes: Uint8Array): string {
  const ascii = (a: number, b: number) => new TextDecoder().decode(bytes.subarray(a, b));
  if (bytes.length < 16) throw new HttpError(415, 'File is not a supported photograph');
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return 'image/jpeg';
  if ([137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v) && ascii(12,16) === 'IHDR' && ascii(bytes.length-8,bytes.length-4) === 'IEND') return 'image/png';
  if (ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP' && new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(4,true)+8 === bytes.length && ['VP8 ','VP8L','VP8X'].includes(ascii(12,16))) return 'image/webp';
  if (ascii(4,8) === 'ftyp') {
    const box = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0);
    if (box < 16 || box > Math.min(bytes.length,1024) || box % 4 !== 0) throw new HttpError(415, 'Invalid image container');
    const brands = [ascii(8,12)]; for(let i=16;i<box;i+=4) brands.push(ascii(i,i+4));
    if (brands.some(b => ['avif','avis'].includes(b))) return 'image/avif';
    if (brands.some(b => ['heic','heix','hevc','hevx'].includes(b))) return 'image/heic';
    // Generic mif1 containers without a supported codec brand are not assumed to be HEIC.
  }
  throw new HttpError(415, 'Unsupported file contents. Use JPEG, PNG, WebP, AVIF or a HEIC/HEIF file with a supported HEVC brand.');
}
function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let at = 2;
  while (at + 4 < bytes.length) {
    if (bytes[at++] !== 255) break;
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 217 || marker === 218) break;
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    if (at + 2 > bytes.length) break;
    const length = view.getUint16(at); if (length < 2 || at + length > bytes.length) break;
    if ([192,193,194].includes(marker) && length >= 8) return { height: view.getUint16(at+3), width: view.getUint16(at+5) };
    at += length;
  }
  throw new HttpError(415, 'Invalid JPEG preview');
}
async function owned(env: Env, owner: string, vehicle: string): Promise<Vehicle> {
  const rows = await db<Vehicle[]>(env, `vehicles?id=eq.${id(vehicle)}&owner_id=eq.${owner}&status=neq.deleting&select=*,vehicle_specifications(details)`);
  if (!rows[0]) throw new HttpError(404, 'Listing not found'); return rows[0];
}
function project(v: Vehicle) { return { id: v.id, createdAt: v.created_at, updatedAt: v.updated_at, frameCount: v.frame_count, details: v.vehicle_specifications?.details || {}, slug: v.slug, status: v.status }; }
function mediaInfo(m: Media) { return { id: m.id, slot_id: m.slot_id, filename: m.filename, mime: m.mime, original_bytes: m.original_bytes, preview_bytes: m.preview_bytes, thumbnail_bytes: m.assets?.thumbnail?.bytes || 0, created_at: m.created_at }; }
async function session(env: Env, owner: string, upload: string, request: Request): Promise<Upload> {
  const rows = await db<Upload[]>(env, `upload_sessions?id=eq.${id(upload)}&owner_id=eq.${owner}`);
  const value = rows[0]; const token = request.headers.get('X-Upload-Token') || '';
  if (!value || token.length > 100 || await hashText(token) !== value.token_hash) throw new HttpError(404, 'Upload not found');
  if (value.state === 'cancelled' || new Date(value.expires_at).getTime() <= Date.now()) throw new HttpError(410, 'Upload expired. Start again.');
  return value;
}
async function transition(env: Env, upload: Upload, next: string): Promise<void> {
  const changed = await db<Upload[]>(env, `upload_sessions?id=eq.${upload.id}&state=eq.${upload.state}`, { method: 'PATCH', body: JSON.stringify({ state: next }) });
  if (changed.length !== 1) throw new HttpError(409, 'Upload is already being processed or was cancelled');
}
async function serveMedia(request: Request, env: Env, ctx: ExecutionContext, m: Media, publicRequest: boolean): Promise<Response> {
  const original = new URL(request.url).searchParams.get('variant') === 'original';
  const thumbnail = new URL(request.url).searchParams.get('variant') === 'thumbnail';
  if(m.storage_provider!=='cloudinary')throw new HttpError(503,'This legacy original must be transferred from R2 before Cloudinary cutover. Its database record has been preserved.');
  const key = original ? m.original_key : thumbnail ? m.assets.thumbnail?.key : m.preview_key;
  if (!key) throw new HttpError(404, 'No compatible preview exists; the original is preserved.');
  // Permission is checked BEFORE cache lookup. Changing an asset changes its cache key.
  const cacheKey = new Request(`${new URL(request.url).origin}/_private-cache/cloudinary/${encodeURIComponent(key)}`);
  const cache = caches.default;
  const hit = publicRequest ? await cache.match(cacheKey) : undefined;
  let response: Response;
  if (hit) response = new Response(hit.body, hit);
  else {
    const object = await download(env,key);
    response = new Response(object.body, { headers: { 'Content-Type': original ? m.mime : 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
    if (publicRequest) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  // Browsers and intermediate proxies must reauthorize each request after unpublishing.
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  const inspect = original && new URL(request.url).searchParams.get('inspect')==='1';
  response.headers.set('Content-Disposition', `${original && !inspect ? 'attachment' : 'inline'}; filename="${original ? 'original' : 'preview'}.${original ? ({ 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/heic':'heic','image/avif':'avif' }[m.mime] || 'bin') : 'jpg'}"`);
  return response;
}

async function cloudAdminPermit(env:Env){await limit(env,'cloudinary-admin',6);}
async function cloudReady(env:Env):Promise<void>{
  const saved=await db<{snapshot:{preset:string;credits:{usage:number;limit:number}};checked_at:string}[]>(env,'provider_status?id=eq.cloudinary');
  const cached=saved[0];
  let snapshot=cached?.snapshot;
  if(!cached||Date.now()-Date.parse(cached.checked_at)>3600000||snapshot?.preset!==env.CLOUDINARY_UPLOAD_PRESET){
    await cloudAdminPermit(env);
    const preset=await admin<{unsigned:boolean;settings?:Record<string,unknown>;options?:Record<string,unknown>}>(env,`upload_presets/${encodeURIComponent(env.CLOUDINARY_UPLOAD_PRESET)}`);
    const options=preset.options||preset.settings||{};
    const safe=['allowed_formats','type','overwrite','unique_filename','use_filename','backup','resource_type'];
    if(preset.unsigned!==false||Object.keys(options).some(key=>!safe.includes(key)))throw new HttpError(503,'Use a signed raw preset without transformations, folders, conversions, add-ons or access-control overrides.');
    await cloudAdminPermit(env);
    const usage=await admin<{credits:{usage:number;limit:number}}>(env,'usage');
    snapshot={preset:env.CLOUDINARY_UPLOAD_PRESET,credits:usage.credits};
    await db(env,'provider_status?on_conflict=id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({id:'cloudinary',snapshot,checked_at:new Date().toISOString()})});
  }
  if(!snapshot?.credits||!Number.isFinite(snapshot.credits.usage)||!(snapshot.credits.limit>0))throw new HttpError(503,'Cloudinary credit usage could not be verified. Uploads are paused.');
  if(snapshot.credits.usage>=snapshot.credits.limit*0.8)throw new HttpError(409,'Cloudinary credits are near the configured safety threshold. Uploads are paused; check the provider dashboard.');
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname.split('/').filter(Boolean); const method = request.method;
  if (method === 'GET' && path[0] === 'public') {
    if (!slugPattern.test(path[1] || '')) throw new HttpError(404, 'Showroom not found');
    await limit(env, `public:${await hashText(request.headers.get('CF-Connecting-IP') || 'unknown')}`, 240);
    const vehicles = await db<Vehicle[]>(env, `vehicles?slug=eq.${path[1]}&status=eq.published&select=*,vehicle_specifications(details)`);
    const v = vehicles[0]; if (!v) throw new HttpError(404, 'Showroom is unavailable or unpublished');
    if (path.length === 2) {
      const media = await db<Media[]>(env, `media?vehicle_id=eq.${v.id}&order=created_at.asc`);
      return json({ project: project(v), media: media.map(mediaInfo) });
    }
    if (path.length === 4 && path[2] === 'media') {
      const media = await db<Media[]>(env, `media?id=eq.${id(path[3])}&vehicle_id=eq.${v.id}`);
      if (!media[0]) throw new HttpError(404, 'Photo not found');
      return serveMedia(request,env,ctx,media[0],true);
    }
    throw new HttpError(404, 'Route not found');
  }
  const owner = await authenticate(request, env);
  await limit(env, `${method === 'GET' ? 'read' : 'write'}:${owner}`, method === 'GET' ? 180 : 90);
  if (path[0] === 'vehicles') {
    if (path.length === 1 && method === 'GET') {
      return json((await db<Vehicle[]>(env, `vehicles?owner_id=eq.${owner}&status=neq.deleting&select=*,vehicle_specifications(details)&order=updated_at.desc`)).map(project));
    }
    const vehicleId = id(path[1] || '');
    if (path.length === 2 && method === 'PUT') {
      const data = await body(request);
      if (data.frameCount !== 24 && data.frameCount !== 48) throw new HttpError(400, 'Invalid capture plan');
      const fields = ['make','model','year','trim','mileage','price','currency','location','transmission','fuel','color','description'];
      if (!data.details || typeof data.details !== 'object' || Array.isArray(data.details)) throw new HttpError(400, 'Car details required');
      const source = data.details as Record<string, unknown>; const details: Record<string,string> = {};
      for (const key of fields) { const value = source[key] ?? ''; if (typeof value !== 'string' || value.length > (key === 'description' ? 3000 : 120)) throw new HttpError(400, 'Invalid listing details'); details[key] = value.trim(); }
      for (const key of ['year','mileage','price']) if (details[key] && (!/^\d+(\.\d{1,2})?$/.test(details[key]) || !Number.isFinite(Number(details[key])))) throw new HttpError(400, 'Invalid numeric listing details');
      if (details.year && (!/^\d{4}$/.test(details.year) || Number(details.year)<1886 || Number(details.year)>new Date().getFullYear()+1)) throw new HttpError(400,'Invalid model year');
      await rpc(env,'save_vehicle',{p_owner:owner,p_id:vehicleId,p_frames:data.frameCount,p_details:details}); return json({ok:true});
    }
    const vehicle = await owned(env,owner,vehicleId);
    if (path.length === 2 && method === 'GET') return json(project(vehicle));
    if (path.length === 2 && method === 'DELETE') { await rpc(env,'delete_vehicle',{p_owner:owner,p_id:vehicleId}); ctx.waitUntil(cleanup(env)); return json({ok:true}); }
    if (path[2] === 'media' && method === 'GET') {
      if (path.length === 3) return json((await db<Media[]>(env,`media?vehicle_id=eq.${vehicleId}&owner_id=eq.${owner}&order=created_at.asc`)).map(mediaInfo));
      if (path.length === 4) {
        const media = await db<Media[]>(env,`media?id=eq.${id(path[3])}&vehicle_id=eq.${vehicleId}&owner_id=eq.${owner}`);
        if (!media[0]) throw new HttpError(404,'Photo not found'); return serveMedia(request,env,ctx,media[0],false);
      }
    }
    if (path[2] === 'uploads' && path.length === 3 && method === 'POST') {
      const data = await body(request); const uploadId = crypto.randomUUID(); const token = crypto.randomUUID()+crypto.randomUUID();
      if(!data.parts||typeof data.parts!=='object'||Array.isArray(data.parts))throw new HttpError(400,'File sizes and hashes are required.');
      const assets:AssetPlans={};
      for(const [part,value]of Object.entries(data.parts as Record<string,unknown>)){
        const item=value as {bytes?:unknown;sha256?:unknown};
        if(!['original','preview','thumbnail'].includes(part)||!item||typeof item.bytes!=='number'||!Number.isSafeInteger(item.bytes)||item.bytes<1||typeof item.sha256!=='string'||!/^[0-9a-f]{64}$/.test(item.sha256))throw new HttpError(400,'Invalid file commitment');
        assets[part]={key:`auto360/${uploadId}/${part}.a360`,bytes:item.bytes,sha256:item.sha256};
      }
      await cloudReady(env);
      const upload=await rpc<Upload>(env,'reserve_cloudinary_upload',{p_owner:owner,p_vehicle:vehicleId,p_id:uploadId,p_slot:required(data.slotId,60),p_hash:await hashText(token),p_filename:required(data.filename),p_assets:assets});
      const uploads:Record<string,Awaited<ReturnType<typeof signedUpload>>>={};
      for(const [part,asset]of Object.entries(assets))uploads[part]=await signedUpload(env,asset,upload.created_at);
      return json({id:uploadId,token,expiresIn:900,providerSignatureSeconds:3600,uploads},201);
    }
    if (path[2] === 'publication' && path.length === 3 && method === 'POST') {
      const data = await body(request); if(typeof data.published !== 'boolean') throw new HttpError(400,'Publication state required');
      const slug = await rpc<string>(env,'publish_vehicle',{p_owner:owner,p_id:vehicleId,p_publish:data.published});
      return json({slug,publicUrl:`${env.FRONTEND_ORIGIN}/car/${slug}`});
    }
  }
  if (path[0] === 'uploads') {
    const uploadId = id(path[1] || '');
    if (path.length === 2 && method === 'DELETE') { await rpc(env,'cancel_upload',{p_owner:owner,p_id:uploadId}); return json({ok:true}); }
    const upload = await session(env,owner,uploadId,request);
    if (path.length === 3 && path[2] === 'finalize' && method === 'POST') {
      if (upload.state === 'complete') return json({ok:true});
      if (upload.storage_provider!=='cloudinary'||upload.state !== 'initiated') throw new HttpError(409,'Upload is already being verified or belongs to the legacy storage provider');
      await transition(env,upload,'finalizing');
      try {
        await cloudAdminPermit(env);
        const assets=await inventory(env,`auto360/${upload.id}/`);const verified:AssetPlans={};let originalMime='';
        for(const [part,plan]of Object.entries(upload.assets)){
          const result=await verifiedBytes(env,plan,assets,boundedBody);const mime=sniff(result.bytes);
          const dimensions=imageDimensions(result.bytes,mime,jpegDimensions);
          const maxPixels=Math.min(25000000,Number(env.MAX_ORIGINAL_PIXELS)||25000000);
          if(!dimensions.width||!dimensions.height||dimensions.width*dimensions.height>maxPixels)throw new HttpError(415,'Photo exceeds the configured pixel limit. Original was not resized.');
          if(part!=='original'&&(mime!=='image/jpeg'||dimensions.width>(part==='thumbnail'?240:960)||dimensions.height>(part==='thumbnail'?240:960)))throw new HttpError(415,'Invalid separate preview or thumbnail');
          if(part==='original')originalMime=mime;
          verified[part]={...plan,assetId:result.assetId};
        }
        if(!originalMime)throw new HttpError(409,'Original verification is missing');
        await rpc(env,'complete_cloudinary_upload',{p_owner:owner,p_id:upload.id,p_mime:originalMime,p_assets:verified});
        return json({ok:true});
      } catch(error) {
        if((error instanceof HttpError||error instanceof CloudinaryError)&&[429,503].includes(error.status)){
          await transition(env,{...upload,state:'finalizing'},'initiated').catch(()=>{});
        }else await rpc(env,'cancel_upload',{p_owner:owner,p_id:uploadId}).catch(()=>{});
        throw error;
      }
    }
  }
  if (path[0]==='media' && path.length===2 && method==='DELETE') { await rpc(env,'remove_media',{p_owner:owner,p_id:id(path[1])}); ctx.waitUntil(cleanup(env)); return json({ok:true}); }
  if (path[0]==='storage' && path.length===1 && method==='GET') {
    return json(await rpc(env,'storage_usage',{p_owner:owner}));
  }
  throw new HttpError(404,'Route not found');
}
async function cleanup(env: Env): Promise<void> {
  const expired = await db<Upload[]>(env,`upload_sessions?expires_at=lt.${encodeURIComponent(new Date().toISOString())}&state=not.in.(complete,cancelled)&limit=5`);
  for(const u of expired) await rpc(env,'cancel_upload',{p_owner:u.owner_id,p_id:u.id});
  const jobs = await db<{id:string;original_key:string;assets:AssetPlans}[]>(env,`storage_gc?storage_provider=eq.cloudinary&not_before=lte.${encodeURIComponent(new Date().toISOString())}&limit=2&order=created_at.asc`);
  for(const job of jobs) {
    try {
      for(const asset of Object.values(job.assets))await destroy(env,asset.key);
      await cloudAdminPermit(env);
      // Known signed namespaces are persisted before any signature is issued. Scan the
      // entire session prefix to catch late, abandoned or otherwise orphaned raw assets.
      const prefix=job.original_key.slice(0,job.original_key.lastIndexOf('/')+1);
      const remaining=await inventory(env,prefix);
      if(remaining.length){for(const asset of remaining)await destroy(env,asset.public_id);continue;}
      await rpc(env,'finish_gc',{p_id:job.id});
    } catch { /* Retain accounting and retry on the next scheduled run. */ }
  }
  await db(env,`api_rate_limits?window_start=lt.${encodeURIComponent(new Date(Date.now()-3600000).toISOString())}`,{method:'DELETE'});
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowed = env.ALLOWED_ORIGINS.split(',').map(s=>s.trim());
    if (origin && !allowed.includes(origin)) return json({error:'Origin is not allowed'},403);
    const cors = new Headers({ 'Vary':'Origin','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer' });
    if(origin) cors.set('Access-Control-Allow-Origin',origin);
    cors.set('Access-Control-Allow-Methods','GET,PUT,POST,DELETE,OPTIONS');
    cors.set('Access-Control-Allow-Headers','Authorization,Content-Type,X-Upload-Token');
    cors.set('Access-Control-Max-Age','600');
    if(request.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
    try { const result = await route(request,env,ctx); cors.forEach((v,k)=>result.headers.set(k,v)); return result; }
    catch(error) { const known=error instanceof HttpError||error instanceof CloudinaryError;const status=known?error.status:500; const response = json({error:known?error.message:'Service unavailable. Please retry.'},status); cors.forEach((v,k)=>response.headers.set(k,v)); if(status===429) response.headers.set('Retry-After','60'); return response; }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(cleanup(env)); },
} satisfies ExportedHandler<Env>;
