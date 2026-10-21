import { useEffect, useRef, useState } from 'react';
import { loadPrivateImage } from './backend';

export default function OriginalInspection({url,privateFile=false}:{url:string;privateFile?:boolean}) {
  const dialog=useRef<HTMLDialogElement>(null);const previous=useRef<HTMLElement|null>(null);
  const [source,setSource]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [zoom,setZoom]=useState(1);
  useEffect(()=>()=>{if(source)URL.revokeObjectURL(source);},[source]);
  return <><button type="button" className="button secondary" disabled={busy} onClick={async()=>{
    previous.current=document.activeElement as HTMLElement|null;setBusy(true);setError('');setZoom(1);dialog.current?.showModal();
    try {const file=privateFile?await loadPrivateImage(url):await fetch(url).then(r=>{if(!r.ok)throw new Error('Original is unavailable or the listing is unpublished.');return r.blob();});if(dialog.current?.open)setSource(URL.createObjectURL(file));}
    catch(e){setError(e instanceof Error?e.message:'Unable to load original.');}finally{setBusy(false);}
  }}>Inspect original / zoom</button><dialog ref={dialog} aria-label="Full-quality original inspection" onClose={()=>{setSource('');previous.current?.focus();}}>
    <div className="dialog-top"><h2>Original inspection</h2><button className="button secondary" onClick={()=>dialog.current?.close()}>Close</button></div>
    <label className="field">Zoom {zoom.toFixed(1)}×<input type="range" min="1" max="4" step="0.25" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/></label>
    {busy&&<p role="status">Loading the full-quality original…</p>}{error&&<p role="alert">{error}</p>}
    <div style={{overflow:'auto',maxHeight:'60vh',marginTop:16}}>{source&&<img src={source} alt="Full-quality original photograph" onError={()=>setError('This browser cannot display the original format. Use Download original to inspect it in a compatible app.')} style={{width:`${zoom*100}%`,maxWidth:'none'}}/>}</div>
  </dialog></>;
}
