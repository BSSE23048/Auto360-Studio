export interface CloudinaryEnv {
  CLOUDINARY_CLOUD_NAME: string; CLOUDINARY_API_KEY: string; CLOUDINARY_API_SECRET: string;
  CLOUDINARY_UPLOAD_PRESET: string; MAX_ORIGINAL_PIXELS: string;
}
export interface AssetPlan { key: string; bytes: number; sha256: string; assetId?: string }
export type AssetPlans = Record<string, AssetPlan>;
interface Asset { public_id: string; asset_id: string; resource_type: string; type: string; bytes: number; version: number }
export class CloudinaryError extends Error { constructor(public status: number, message: string) { super(message); } }
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(b=>b.toString(16).padStart(2,'0')).join('');
export const digest = async (bytes: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', bytes));
async function signature(env: CloudinaryEnv, values: Record<string,string>): Promise<string> {
  const text=Object.keys(values).sort().map(key=>`${key}=${values[key]}`).join('&')+env.CLOUDINARY_API_SECRET;
  return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
}
function endpoint(env:CloudinaryEnv,path:string) {
  if(!/^[a-z0-9_-]+$/i.test(env.CLOUDINARY_CLOUD_NAME||''))throw new CloudinaryError(503,'Configure Cloudinary credentials first.');
  return `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${path}`;
}
export async function signedUpload(env:CloudinaryEnv,asset:AssetPlan,createdAt:string) {
  if(!env.CLOUDINARY_UPLOAD_PRESET)throw new CloudinaryError(503,'A reviewed signed raw upload preset is required.');
  // .a360 is a raw-only extension. allowed_formats prevents replay at image/video endpoints,
  // whose resource_type is NOT covered by Cloudinary's upload signature.
  const params:Record<string,string>={public_id:asset.key,timestamp:String(Math.floor(Date.parse(createdAt)/1000)),type:'authenticated',overwrite:'false',unique_filename:'false',use_filename:'false',backup:'false',allowed_formats:'a360',upload_preset:env.CLOUDINARY_UPLOAD_PRESET};
  return {url:endpoint(env,'raw/upload'),params:{...params,api_key:env.CLOUDINARY_API_KEY,signature:await signature(env,params)},filename:'photo.a360'};
}
export async function admin<T>(env:CloudinaryEnv,path:string):Promise<T> {
  const response=await fetch(endpoint(env,path),{headers:{Authorization:`Basic ${btoa(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`)}`},redirect:'error'});
  if(!response.ok)throw new CloudinaryError(response.status===429?429:503,'Cloudinary verification is unavailable or its API limit was reached. Try later.');
  return response.json() as Promise<T>;
}
export async function inventory(env:CloudinaryEnv,prefix:string) {
  const result=await admin<{resources:Asset[];next_cursor?:string}>(env,`resources/raw/authenticated?prefix=${encodeURIComponent(prefix)}&max_results=10`);
  if(result.next_cursor)throw new CloudinaryError(409,'Unexpected assets in this upload namespace; cleanup is required.');
  return result.resources;
}
export async function download(env:CloudinaryEnv,key:string):Promise<Response> {
  const timestamp=Math.floor(Date.now()/1000);
  const params:Record<string,string>={public_id:key,type:'authenticated',timestamp:String(timestamp),expires_at:String(timestamp+60),attachment:'false'};
  const query=new URLSearchParams({...params,api_key:env.CLOUDINARY_API_KEY,signature:await signature(env,params)});
  // This URL never reaches the browser; each browser request is authorized by the Worker.
  const response=await fetch(`${endpoint(env,'raw/download')}?${query}`,{redirect:'error'});
  if(!response.ok)throw new CloudinaryError(503,'Private original delivery failed. Check authenticated raw delivery on your Cloudinary account.');
  return response;
}
export async function destroy(env:CloudinaryEnv,key:string):Promise<void> {
  const params={public_id:key,type:'authenticated',invalidate:'true',timestamp:String(Math.floor(Date.now()/1000))};
  const response=await fetch(endpoint(env,'raw/destroy'),{method:'POST',body:new URLSearchParams({...params,api_key:env.CLOUDINARY_API_KEY,signature:await signature(env,params)})});
  const result=await response.json() as {result?:string};
  if(!response.ok||!['ok','not found'].includes(result.result||''))throw new CloudinaryError(503,'Cloudinary cleanup must be retried.');
}
export async function verifiedBytes(env:CloudinaryEnv,plan:AssetPlan,assets:Asset[],read:(response:Response,max:number)=>Promise<Uint8Array>) {
  const asset=assets.find(a=>a.public_id===plan.key);
  if(!asset||asset.resource_type!=='raw'||asset.type!=='authenticated'||asset.bytes!==plan.bytes||!asset.asset_id)throw new CloudinaryError(409,'Uploaded asset does not match the reserved private file.');
  const bytes=await read(await download(env,plan.key),plan.bytes);
  if(bytes.byteLength!==plan.bytes||await digest(bytes)!==plan.sha256)throw new CloudinaryError(409,'Cloudinary did not retain the submitted bytes. The file was rejected; keep your source original.');
  return {bytes,assetId:asset.asset_id};
}
export function imageDimensions(bytes:Uint8Array,mime:string,jpeg:(b:Uint8Array)=>{width:number;height:number}):{width:number;height:number} {
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(mime==='image/jpeg')return jpeg(bytes);
  if(mime==='image/png'&&bytes.length>=24)return {width:v.getUint32(16),height:v.getUint32(20)};
  const str=(a:number,b:number)=>new TextDecoder().decode(bytes.subarray(a,b));
  if(mime==='image/webp'&&bytes.length>=30){
    const type=str(12,16);
    if(type==='VP8X')return {width:1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16),height:1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16)};
    if(type==='VP8 '&&bytes[23]===157&&bytes[24]===1&&bytes[25]===42)return {width:v.getUint16(26,true)&16383,height:v.getUint16(28,true)&16383};
    if(type==='VP8L'&&bytes[20]===47){const bits=v.getUint32(21,true);return {width:(bits&16383)+1,height:((bits>>>14)&16383)+1};}
  }
  if(mime==='image/heic'||mime==='image/avif'){
    const dimensions:{width:number;height:number}[]=[];
    const walk=(start:number,end:number,depth:number)=>{if(depth>8)return;for(let at=start;at+8<=end;){const size=v.getUint32(at);if(size<8||at+size>end)return;const type=str(at+4,at+8);if(type==='ispe'&&size>=20)dimensions.push({width:v.getUint32(at+12),height:v.getUint32(at+16)});else if(['meta','iprp','ipco'].includes(type))walk(at+(type==='meta'?12:8),at+size,depth+1);at+=size;}};
    walk(0,bytes.length,0);if(dimensions.length)return dimensions.sort((a,b)=>b.width*b.height-a.width*a.height)[0];
  }
  throw new CloudinaryError(415,'Cannot safely determine image dimensions. Keep this original; choose a supported JPEG/PNG/WebP or HEIC/AVIF with readable dimensions. No conversion was performed.');
}
