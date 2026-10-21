import { createClient } from '@supabase/supabase-js';
import type { OriginalPhoto, Project, ShowroomRepository } from './model';

const env = (import.meta as unknown as { env: Record<string, string> }).env;
export const cloudEnabled = Boolean(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY && env.VITE_API_URL);
export const supabase = cloudEnabled ? createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY) : null;
const base = (env.VITE_API_URL || '').replace(/\/$/, '');
class ApiError extends Error { constructor(public status:number,message:string){super(message);} }
export async function api<T>(path: string, init: RequestInit = {}, anonymous = false): Promise<T> {
  const token = anonymous ? undefined : (await supabase?.auth.getSession())?.data.session?.access_token;
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(`${base}${path}`, { ...init, headers });
  if (!response.ok) { const error = await response.json().catch(() => ({})) as { error?: string }; throw new ApiError(response.status,error.error || `Request failed (${response.status})`); }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
async function blob(path: string, signal?: AbortSignal): Promise<Blob> {
  const token = (await supabase?.auth.getSession())?.data.session?.access_token;
  const response = await fetch(`${base}${path}`, { signal, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error('Unable to load this private image.');
  return response.blob();
}
export interface CloudMedia { id: string; slot_id: string; filename: string; mime: string; original_bytes: number; preview_bytes: number; thumbnail_bytes?: number; created_at: string }
export interface PublicShowroom { project: Project; media: CloudMedia[] }
export function publicImage(slug: string, id: string, original = false): string { return `${base}/public/${encodeURIComponent(slug)}/media/${id}?variant=${original ? 'original' : 'preview'}`; }
export async function makePreview(original: Blob, edge = 960): Promise<Blob | null> {
  // Decode a copy only. The source Blob is uploaded byte-for-byte independently.
  const render = async (source: CanvasImageSource, width: number, height: number): Promise<Blob | null> => {
    if(!width||!height)return null;
    const scale=Math.min(1,edge/Math.max(width,height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
    const context=canvas.getContext('2d');if(!context)return null;context.fillStyle='#151b17';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(source,0,0,canvas.width,canvas.height);
    const preview=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',0.72));return preview&&preview.size<=(edge===240?131072:917504)?preview:null;
  };
  try {
    const bitmap = await createImageBitmap(original, { imageOrientation: 'from-image' });
    try { return await render(bitmap,bitmap.width,bitmap.height); } finally { bitmap.close(); }
  } catch {
    // Safari may render a format through HTMLImageElement without ImageBitmap support.
    const url=URL.createObjectURL(original);
    try{const image=new Image();await new Promise<void>((resolve,reject)=>{const timer=window.setTimeout(()=>reject(new Error('Preview decoding timed out')),12000);image.onload=()=>{clearTimeout(timer);resolve();};image.onerror=()=>{clearTimeout(timer);reject(new Error('Unsupported preview format'));};image.src=url;});return await render(image,image.naturalWidth,image.naturalHeight);}catch{return null;}finally{URL.revokeObjectURL(url);}
  }
}
export const cloudRepository: ShowroomRepository = {
  listProjects: () => api<Project[]>('/vehicles'),
  saveProject: project => api<void>(`/vehicles/${project.id}`, { method: 'PUT', body: JSON.stringify(project) }),
  deleteProject: id => api<void>(`/vehicles/${id}`, { method: 'DELETE' }),
  getPhotos: async projectId => {
    const media = await api<CloudMedia[]>(`/vehicles/${projectId}/media`);
    // Previews load first; originals are fetched only by explicit owner actions.
    return media.map(item => ({ id: item.id, projectId, slotId: item.slot_id, original: new Blob(), filename: item.filename, mime: item.mime, bytes: item.original_bytes, uploadedAt: item.created_at, previewSupported: Boolean(item.preview_bytes), remotePreview: item.preview_bytes ? `${base}/vehicles/${projectId}/media/${item.id}?variant=preview&v=${encodeURIComponent(item.created_at)}` : undefined, remoteThumbnail: item.thumbnail_bytes ? `${base}/vehicles/${projectId}/media/${item.id}?variant=thumbnail&v=${encodeURIComponent(item.created_at)}` : undefined, remoteOriginal: `/vehicles/${projectId}/media/${item.id}?variant=original` }));
  },
  savePhoto: async photo => {
    const usage=await api<{limits:{originalBytes:number}}>('/storage');
    if(!photo.original.size||photo.original.size>usage.limits.originalBytes)throw new Error(`Original exceeds the configured ${Math.floor(usage.limits.originalBytes/1000000)} MB limit. It has not been resized or uploaded.`);
    const preview = await makePreview(photo.previewSource ?? photo.original);
    const thumbnail=preview?await makePreview(preview,240):null;
    if((preview&&!thumbnail)||(photo.previewSource&&!preview))throw new Error('A separate preview could not be generated. Choose a compatible JPEG/PNG copy without changing your original.');
    const files:Record<string,Blob>={original:photo.original,...(preview&&thumbnail?{preview,thumbnail}:{})};
    const parts:Record<string,{bytes:number;sha256:string}>={};
    for(const [part,file]of Object.entries(files)){const hash=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());parts[part]={bytes:file.size,sha256:[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('')};}
    const session = await api<{ id: string; token: string; uploads:Record<string,{url:string;params:Record<string,string>;filename:string}> }>(`/vehicles/${photo.projectId}/uploads`, { method: 'POST', body: JSON.stringify({ slotId: photo.slotId, filename: photo.filename, parts }) });
    try {
      for(const [part,file]of Object.entries(files)){
        const signed=session.uploads[part];
        if(!signed||new URL(signed.url).origin!=='https://api.cloudinary.com')throw new Error('Unexpected upload provider');
        const form=new FormData();for(const [key,value]of Object.entries(signed.params))form.append(key,value);
        form.append('file',file,signed.filename);
        const response=await fetch(signed.url,{method:'POST',body:form});
        if(!response.ok){const result=await response.json().catch(()=>({})) as {error?:{message?:string}};throw new Error(result.error?.message||'Cloudinary rejected the original. No compression or format conversion was attempted.');}
        // Cloudinary's browser response is NOT trusted as evidence of completion.
      }
      // Retry verification only; never repeat the file upload or mint extra signatures.
      for(let attempt=0;attempt<3;attempt++){
        try{await api(`/uploads/${session.id}/finalize`, { method: 'POST', headers: { 'X-Upload-Token': session.token } });break;}
        catch(error){if(!(error instanceof ApiError)||![429,503].includes(error.status)||attempt===2)throw error;await new Promise(resolve=>window.setTimeout(resolve,60000));}
      }
    } catch (error) { await api(`/uploads/${session.id}`, { method: 'DELETE' }).catch(() => {}); throw error; }
  },
  deletePhoto: id => api<void>(`/media/${id}`, { method: 'DELETE' }),
};
export async function loadPrivateImage(url: string, signal?: AbortSignal): Promise<Blob> { return blob(url.startsWith(base) ? url.slice(base.length) : url, signal); }
