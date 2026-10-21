import { useEffect, useMemo, useRef, useState } from 'react';
import { loadPrivateImage, publicImage, type CloudMedia } from '../backend';
import { INSPECTIONS, EXTRAS, position, type OriginalPhoto } from '../model';
import OriginalInspection from '../OriginalInspection';
import ZoomImage from './ZoomImage';

export interface ViewerHotspot { id:string; label:string; frameAngles:number[]; x:number; y:number; slots:string[] }
interface Media {id:string;slot:string;label:string;preview?:string;thumbnail?:string;original?:string;filename:string;angle?:number}
interface Props {photos?:OriginalPhoto[];media?:CloudMedia[];slug?:string;frameCount:24|36|48;hotspots?:ViewerHotspot[]}
/** Populate by stable listing ID/slug only after checking coordinates on the actual frames.
 * Example entry: {id:'bonnet',label:'Bonnet & engine',frameAngles:[0],x:.5,y:.45,slots:['engine']}
 * x/y are fractions of the photograph, not of the letterboxed viewer.
 */
export const LISTING_HOTSPOTS:Record<string,ViewerHotspot[]>={};
// Coordinates must be calibrated against the seller's actual photograph. No guessed hotspots.
const EMPTY_HOTSPOTS:ViewerHotspot[]=[];
const labels=new Map([...INSPECTIONS,...EXTRAS].map(s=>[s.id,s.title]));
export default function CarViewer({photos,media,slug,frameCount,hotspots=EMPTY_HOTSPOTS}:Props){
  const privateFile=!slug;
  hotspots=hotspots.length?hotspots:LISTING_HOTSPOTS[slug||photos?.[0]?.projectId||'']||EMPTY_HOTSPOTS;
  const items=useMemo<Media[]>(()=>{
    const list=slug?(media||[]).map(m=>({id:m.id,slot:m.slot_id,preview:m.preview_bytes?publicImage(slug,m.id):undefined,thumbnail:m.thumbnail_bytes?publicImage(slug,m.id).replace('variant=preview','variant=thumbnail'):undefined,original:publicImage(slug,m.id,true),filename:m.filename})):(photos||[]).map(p=>({id:p.id,slot:p.slotId,preview:p.remotePreview,thumbnail:p.remoteThumbnail,original:p.remoteOriginal,filename:p.filename}));
    return list.map(m=>{const angle=m.slot.startsWith('ext-')?Number(m.slot.slice(4)):undefined;return {...m,angle,label:angle===undefined?labels.get(m.slot)||m.slot:`${angle}° · ${position(angle)}`};});
  },[photos,media,slug]);
  const exterior=useMemo(()=>items.filter(m=>m.angle!==undefined&&m.preview).sort((a,b)=>a.angle!-b.angle!),[items]);
  const [category,setCategory]=useState('exterior');const [angleIndex,setAngleIndex]=useState(0);const [galleryIndex,setGalleryIndex]=useState(0);const [part,setPart]=useState<ViewerHotspot|null>(null);const [hint,setHint]=useState(true);
  const gallery=category==='exterior'?exterior:items.filter(m=>m.angle===undefined&&(part?part.slots.includes(m.slot):category==='interior'?['front-interior','rear-interior','odometer'].includes(m.slot):category==='details'?EXTRAS.some(s=>s.id===m.slot):true));
  const index=category==='exterior'?angleIndex:galleryIndex;const wanted=gallery[((index%gallery.length)+gallery.length)%gallery.length];
  const [shown,setShown]=useState<{item:Media;url:string}|null>(null);const [error,setError]=useState('');const [revision,setRevision]=useState(0);
  const cache=useRef(new Map<string,{url:string;bytes:number}>());const shownId=useRef('');const generation=useRef(0);const prefetched=useRef(new Set<string>());
  useEffect(()=>{setShown(null);prefetched.current.clear();return()=>{for(const v of cache.current.values())URL.revokeObjectURL(v.url);cache.current.clear();};},[items]);
  useEffect(()=>{
    const run=++generation.current;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    setError('');if(!wanted?.preview){setShown(null);return;}
    // One request at a time: requested frame, immediate neighbours, then remaining exterior previews.
    const connection=(navigator as Navigator & {connection?:{saveData?:boolean;effectiveType?:string}}).connection;
    const conserve=connection?.saveData||['slow-2g','2g'].includes(connection?.effectiveType||'');
    const ordered=[wanted,...(category==='exterior'&&!conserve?[exterior[(angleIndex+1)%exterior.length],exterior[(angleIndex-1+exterior.length)%exterior.length],...exterior]:[])].filter((v,i,a)=>v&&a.findIndex(x=>x?.id===v.id)===i);
    async function load(item:Media){
      if(!item.preview)return;
      let cached=cache.current.get(item.id);
      if(!cached){const blob=privateFile?await loadPrivateImage(item.preview,controller.signal):await fetch(item.preview,{signal:controller.signal,cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('Photo unavailable. Access may have changed.');return r.blob();});
        const url=URL.createObjectURL(blob);const image=new Image();image.src=url;try{await image.decode();}catch{URL.revokeObjectURL(url);throw new Error('Preview cannot be displayed. Try the original in a compatible app.');}
        if(controller.signal.aborted){URL.revokeObjectURL(url);return;}cached={url,bytes:blob.size};cache.current.set(item.id,cached);
      }
      cache.current.delete(item.id);cache.current.set(item.id,cached);
      if(item.id===wanted?.id&&run===generation.current){shownId.current=item.id;setShown({item,url:cached.url});}
      // Bound compressed data to 16 MiB / 48 frames; only current image stays decoded in the DOM.
      let bytes=[...cache.current.values()].reduce((n,v)=>n+v.bytes,0);
      for(const [id,value] of cache.current){if(bytes<=16*1024*1024&&cache.current.size<=48)break;if(id===shownId.current||id===wanted?.id)continue;URL.revokeObjectURL(value.url);cache.current.delete(id);bytes-=value.bytes;}
    }
    async function next(i:number):Promise<void>{
      if(controller.signal.aborted||i>=ordered.length)return;
      const item=ordered[i];
      if(i===0||!prefetched.current.has(item.id)){
        try{await load(item);if(!controller.signal.aborted)prefetched.current.add(item.id);}
        catch(e){if(!controller.signal.aborted&&i===0){setError(e instanceof Error?e.message:'Unable to load image.');return;}if(!controller.signal.aborted)prefetched.current.add(item.id);}
      }
      if(!controller.signal.aborted)timer=setTimeout(()=>void next(i+1),i===0?80:300);
    }
    void next(0);return()=>{controller.abort();if(timer)clearTimeout(timer);};
  },[wanted?.id,category,items,revision]);
  function step(delta:number){setHint(false);if(!gallery.length)return;const update=(i:number)=>(i+delta%gallery.length+gallery.length)%gallery.length;if(category==='exterior')setAngleIndex(update);else setGalleryIndex(update);}
  function choose(value:string){setCategory(value);setPart(null);setGalleryIndex(0);}
  const current=shown?.item;const matching=shown&&shown.item.id===wanted?.id;
  return <div className="car-viewer"><div className="car-gallery-label"><span className="pill">{category==='exterior'?'360° · REAL PHOTOGRAPHS':'STATIC INSPECTION PHOTOGRAPH'}</span>{category!=='exterior'&&<button type="button" className="button secondary" onClick={()=>choose('exterior')}>Return to exterior</button>}</div>
    {shown?<ZoomImage src={shown.url} alt={current?.label||'Car photograph'} onStep={step}>{category==='exterior'&&matching&&hotspots.filter(h=>h.frameAngles.includes(current?.angle??-1)&&h.x>=0&&h.x<=1&&h.y>=0&&h.y<=1).map(h=>{const available=items.some(m=>h.slots.includes(m.slot));return <button key={h.id} type="button" className="car-hotspot" style={{left:`${h.x*100}%`,top:`${h.y*100}%`}} title={h.label+(available?'':' — photo unavailable')} aria-label={h.label+(available?'':' — photo unavailable')} disabled={!available} onClick={()=>{setPart(h);setCategory('inspection');setGalleryIndex(0);setHint(false);}}>+</button>;})}</ZoomImage>:<div className="car-empty" role="status">{wanted?.preview?'Loading preview…':wanted?'No compatible preview. Inspect the original below.':'No photographs available in this gallery.'}</div>}
    <div className="viewer-controls"><button type="button" className="icon-button" aria-label="Previous photograph" disabled={!gallery.length} onClick={()=>step(-1)}>←</button><div aria-live="polite"><strong>{current?.label||wanted?.label||'No photo'}</strong><small>{!matching&&wanted?.preview?'Loading selected position…':hint?'Swipe to rotate or use the arrows':`${gallery.length?index%gallery.length+1:0} / ${gallery.length}`}</small></div><button type="button" className="icon-button" aria-label="Next photograph" disabled={!gallery.length} onClick={()=>step(1)}>→</button></div>
    {error&&<p role="alert">{error} <button type="button" className="button secondary" onClick={()=>setRevision(n=>n+1)}>Retry</button></p>}
    {category==='exterior'&&exterior.length<frameCount&&<p className="car-caption muted">{frameCount-exterior.length} exterior previews missing. Rotation skips unavailable positions; no angles are generated.</p>}
    <div className="car-choices" role="group" aria-label="Gallery">{['exterior','interior','inspection','details'].map(c=><button type="button" key={c} aria-pressed={category===c&&!part} onClick={()=>choose(c)}>{c[0].toUpperCase()+c.slice(1)}</button>)}</div>
    <div className="car-choices" role="group" aria-label="Choose photograph">{gallery.map((m,i)=><button type="button" key={m.id} aria-pressed={wanted?.id===m.id} onClick={()=>{setHint(false);if(category==='exterior')setAngleIndex(i);else setGalleryIndex(i);}}>{m.thumbnail&&!privateFile&&<img src={m.thumbnail} loading="lazy" alt=""/>}{m.label}</button>)}</div>
    {category!=='exterior'&&<div className="car-choices" role="group" aria-label="Inspection areas">{[...INSPECTIONS,...EXTRAS].map(s=>{const available=items.some(m=>m.slot===s.id);return <button type="button" key={s.id} disabled={!available} onClick={()=>{setPart({id:s.id,label:s.title,slots:[s.id],frameAngles:[],x:0,y:0});setCategory('inspection');setGalleryIndex(0);setShown(null);}}>{s.title}{!available?' · unavailable':''}</button>;})}</div>}
    {(current||wanted)?.original&&<OriginalInspection key={(current||wanted)!.id} url={(current||wanted)!.original!} filename={(current||wanted)!.filename} privateFile={privateFile}/>}
    <p className="car-caption muted">Inspection views show actual uploaded photographs, not animated opening parts.</p>
  </div>;
}
