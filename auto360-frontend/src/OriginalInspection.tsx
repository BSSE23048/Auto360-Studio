import { useEffect, useRef, useState } from 'react';
import { loadPrivateImage } from './backend';
import ZoomImage from './viewer/ZoomImage';

export default function OriginalInspection({url,privateFile=false,filename='original',label='Inspect original / fullscreen'}:{url:string;privateFile?:boolean;filename?:string;label?:string}) {
  const dialog=useRef<HTMLDialogElement>(null);const previous=useRef<HTMLElement|null>(null);const request=useRef<AbortController|null>(null);
  const [source,setSource]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  useEffect(()=>()=>{if(source)URL.revokeObjectURL(source);},[source]);
  useEffect(()=>()=>request.current?.abort(),[]);
  async function open(){
    previous.current=document.activeElement as HTMLElement|null;if(!dialog.current?.open)dialog.current?.showModal();setBusy(true);setError('');
    request.current?.abort();const controller=new AbortController();request.current=controller;
    try{const file=privateFile?await loadPrivateImage(url,controller.signal):await fetch(url,{signal:controller.signal,cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('Original unavailable. The listing may have been unpublished.');return r.blob();});if(!controller.signal.aborted)setSource(URL.createObjectURL(file));}
    catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Unable to load original.');}finally{if(!controller.signal.aborted)setBusy(false);}
  }
  return <><button type="button" className="button secondary" onClick={open}>{label}</button><dialog className="car-inspection-dialog" ref={dialog} aria-label="Full-quality original inspection" onClose={()=>{request.current?.abort();setSource('');setBusy(false);previous.current?.focus();}}>
    <div className="dialog-top"><h2>Original inspection</h2><button type="button" className="button secondary" onClick={()=>dialog.current?.close()}>Close</button></div>
    {busy&&<p role="status">Loading the unchanged original…</p>}{error&&<p role="alert">{error} <button type="button" className="button secondary" onClick={open}>Retry</button></p>}
    {source&&<><ZoomImage src={source} alt={filename} original/><a className="button secondary" href={source} download={filename}>Download unchanged original</a></>}
  </dialog></>;
}
