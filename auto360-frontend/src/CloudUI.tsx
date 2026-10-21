import BuyerActions from './BuyerActions';
import CarViewer from './viewer/ViewerLoader';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, Download, LoaderCircle, LockKeyhole, LogOut, RotateCcw, ShieldCheck } from 'lucide-react';
import { api, cloudRepository, loadPrivateImage, publicImage, supabase, type PublicShowroom } from './backend';
import { slots, title, type OriginalPhoto, type Project } from './model';
import OriginalInspection from './OriginalInspection';

export function CompatiblePreview({photo}:{photo:OriginalPhoto}) {
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  return <div className="compatible-preview"><p className="cloud-storage-note">This original has no compatible preview. Choose a JPEG/PNG copy of this same photograph. It is used only for the separate preview; your existing original bytes stay unchanged.</p><label className="button secondary">{busy?'Saving separate preview…':'Add compatible preview'}<input className="sr-only" type="file" accept="image/jpeg,image/png" disabled={busy} onChange={async e=>{const file=e.target.files?.[0];e.target.value='';if(!file||!photo.remoteOriginal)return;if(file.size>20000000){setError('Choose a compatible copy under 20 MB.');return;}setBusy(true);setError('');try{const original=await loadPrivateImage(photo.remoteOriginal);await cloudRepository.savePhoto({...photo,original,previewSource:file});window.location.reload();}catch(error){setError(error instanceof Error?error.message:'Preview upload failed');}finally{setBusy(false);}}}/></label>{error&&<p className="notice error" role="alert">{error}</p>}</div>;
}

export function CloudAuth({ register }: { register: boolean }) {
  const [email,setEmail] = useState(''); const [password,setPassword] = useState(''); const [name,setName] = useState('');
  const [busy,setBusy] = useState(false); const [error,setError] = useState(''); const [message,setMessage] = useState('');
  useEffect(()=>{setError('');setMessage('');setPassword('');},[register]);
  async function submit(event:FormEvent) {
    event.preventDefault(); if(!supabase || busy) return; setBusy(true);setError('');setMessage('');
    try {
      if(register) {
        const {data,error:authError} = await supabase.auth.signUp({email,password,options:{data:{name:name.trim()},emailRedirectTo:`${location.origin}/#/dashboard`}});
        if(authError) throw authError;
        if(data.session) location.hash='/dashboard'; else setMessage('Check your email to confirm your account, then sign in. If you already have an account, use sign in.');
      } else {
        const {error:authError} = await supabase.auth.signInWithPassword({email,password}); if(authError) throw authError; location.hash='/dashboard';
      }
      setPassword('');
    } catch(e) {setError(e instanceof Error?e.message:'Authentication failed.');} finally {setBusy(false);}
  }
  return <div className="container page narrow"><a className="back-link" href="#/"><ArrowLeft size={16}/>Home</a><section className="panel auth-card cloud-auth"><div className="eyebrow">YOUR PRIVATE STUDIO</div><h1>{register?'Make yourself at home.':'Welcome back.'}</h1><p>{register?'Create your account to save original photographs securely.':'Sign in to manage your cars and published showrooms.'}</p><form onSubmit={submit}>{register&&<label className="field"><span>Your name</span><input required maxLength={100} autoComplete="name" value={name} onChange={e=>setName(e.target.value)}/></label>}<label className="field"><span>Email address</span><input type="email" required autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)}/></label><label className="field"><span>Password</span><input type="password" required minLength={8} autoComplete={register?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="button full" disabled={busy}>{busy?<LoaderCircle className="spin" size={18}/>:<LockKeyhole size={18}/>} {register?'Create account':'Sign in'}</button></form>{error&&<p className="notice error" role="alert">{error}</p>}{message&&<p className="notice" role="status">{message}</p>}<p className="auth-switch">{register?'Already registered?':'New here?'} <a href={register?'#/login':'#/register'}>{register?'Sign in':'Create an account'}</a></p><small className="muted">Accounts use Supabase Auth. Existing local drafts stay on their original device; they are not automatically uploaded.</small></section></div>;
}
export function CloudAccount() {
  const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  return <><button className="button ghost" disabled={busy} onClick={async()=>{setBusy(true);const result=await supabase?.auth.signOut();setBusy(false);if(result?.error)setError(result.error.message);else location.hash='/';}}><LogOut size={16}/>Sign out</button>{error&&<span role="alert">{error}</span>}</>;
}
interface StorageUsage {usedBytes:number;reservedBytes:number;cleanupBytes:number;byListing:Record<string,number>;limits:{userBytes:number;listingBytes:number;originalBytes:number};uploadsAvailable:boolean;legacyMediaCount?:number}
const mb=(bytes:number)=>(bytes/1000000).toFixed(1)+' MB';
export function CloudStorage({projectId}:{projectId?:string}) {
  const [usage,setUsage]=useState<StorageUsage>(); const [error,setError]=useState('');
  useEffect(()=>{api<StorageUsage>('/storage').then(setUsage).catch(e=>setError(e.message));},[projectId]);
  if(error)return <div className="notice error" role="alert">Storage status unavailable: {error}</div>;
  return <div className="notice"><ShieldCheck size={18}/><span>{usage?<>{projectId?`${mb(usage.byListing[projectId]||0)} in this listing`:`${mb(usage.usedBytes)} tracked`} · {mb(usage.limits.userBytes)} app account limit · {mb(usage.limits.originalBytes)} per original.<br/>{mb(usage.reservedBytes)} reserved · {mb(usage.cleanupBytes)} awaiting cleanup. {!usage.uploadsAvailable&&'Storage headroom is insufficient. Uploads are paused.'}<br/>These are application-tracked bytes, not Cloudinary credits. Cloudinary also counts bandwidth and transformations; check its dashboard. {!!usage.legacyMediaCount&&`${usage.legacyMediaCount} legacy R2 photos still require transfer.`}</>:'Checking storage…'}</span></div>;
}
export function CloudPublication({project}:{project:Project}) {
  const [published,setPublished]=useState(project.status==='published'); const [url,setURL]=useState(project.slug?`${location.origin}/car/${project.slug}`:'');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [copied,setCopied]=useState(false);
  useEffect(()=>{api<Project>(`/vehicles/${project.id}`).then(p=>{setPublished(p.status==='published');if(p.slug)setURL(`${location.origin}/car/${p.slug}`);}).catch(e=>setError(e.message));},[project.id]);
  async function change(next:boolean){setBusy(true);setError('');try{const result=await api<{publicUrl:string}>(`/vehicles/${project.id}/publication`,{method:'POST',body:JSON.stringify({published:next})});setURL(result.publicUrl);setPublished(next);}catch(e){setError(e instanceof Error?e.message:'Publication failed');}finally{setBusy(false);}}
  return <div className="panel cloud-publication"><div><div className="eyebrow">{published?'LIVE SHOWROOM':'PRIVATE DRAFT'}</div><p>{published?'Your showroom is viewable without a seller account. Unpublishing stops new access; it cannot revoke files a visitor already saved.':'Publishing makes listing information, photographs and original downloads public. Review your photographs for private information first.'}</p></div><div className="inline-actions"><button className={`button ${published?'secondary':''}`} disabled={busy} onClick={()=>void change(!published)}>{busy?'Saving…':published?'Unpublish':'Publish showroom'}<ArrowRight size={16}/></button>{published&&<><a className="button secondary" href={url} target="_blank" rel="noreferrer">Open public link</a><button className="button secondary" onClick={async()=>{try{await navigator.clipboard.writeText(url);setCopied(true);}catch{setError('Copy the displayed public link manually.');}}}>{copied?<Check size={16}/>:<Copy size={16}/>} {copied?'Copied':'Copy link'}</button><a className="button secondary" href={`https://wa.me/?text=${encodeURIComponent(`${title(project)} — ${url}`)}`} target="_blank" rel="noreferrer">Share on WhatsApp</a></>}</div>{published&&<p className="public-url"><a href={url}>{url}</a></p>}{error&&<div className="notice error" role="alert">{error}</div>}</div>;
}
export function PublicCar({slug}:{slug:string}) {
  const [data,setData]=useState<PublicShowroom>();const [error,setError]=useState('');const [group,setGroup]=useState<'exterior'|'inspection'|'extra'>('exterior');const [index,setIndex]=useState(0);
  const [retry,setRetry]=useState(0);
  useEffect(()=>{const controller=new AbortController();setData(undefined);setError('');api<PublicShowroom>(`/public/${encodeURIComponent(slug)}`,{signal:controller.signal},true).then(result=>{if(!controller.signal.aborted)setData(result);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[slug,retry]);
  if(error)return <div className="container empty"><h1>Showroom unavailable</h1><p role="alert">{error}</p><button type="button" className="button secondary" onClick={()=>setRetry(n=>n+1)}>Retry</button><a className="button" href="/#/">Auto360 Studio</a></div>;
  if(!data)return <div className="container page"><div className="viewer-skeleton" role="status">Opening showroom…</div></div>;
  const available=slots(data.project.frameCount).filter(s=>s.group===group&&data.media.some(m=>m.slot_id===s.id));
  const slot=available[index]||available[0];const media=data.media.find(m=>m.slot_id===slot?.id);const d=data.project.details;
  const step=(n:number)=>{if(available.length)setIndex(i=>(i+n+available.length)%available.length);};
  return <div className="container page showroom-page"><div className="page-heading"><div><div className="eyebrow">AUTO360 · OWNER SHOWROOM</div><h1>{title(data.project)}</h1><p>{[d.trim,d.location].filter(Boolean).join(' · ')}</p></div><a className="button secondary" href={`https://wa.me/?text=${encodeURIComponent(location.href)}`} target="_blank" rel="noreferrer">Share showroom</a></div><div className="showroom-layout"><section><BuyerActions name={title(data.project)} phone={d.whatsapp} url={`${location.origin}/car/${encodeURIComponent(slug)}`}/><CarViewer key={slug} media={data.media} slug={slug} frameCount={data.project.frameCount}/></section><aside className="listing-sidebar"><div className="panel listing-details"><div className="eyebrow">ASKING PRICE</div><h2 className="price">{d.price?`${d.currency} ${Number(d.price).toLocaleString()}`:'Price not listed'}</h2><dl>{[['Year',d.year],['Mileage',d.mileage?`${Number(d.mileage).toLocaleString()} km`:''],['Transmission',d.transmission],['Fuel',d.fuel],['Color',d.color],['Location',d.location]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value||'Not provided'}</dd></div>)}</dl><div className="quality-note"><ShieldCheck size={20}/><p>Owner-provided information. Original photographs are preserved. Condition is not independently verified.</p></div></div><div className="panel listing-description"><h3>The car’s story</h3><p>{d.description||'No description provided.'}</p></div></aside></div></div>;
}
