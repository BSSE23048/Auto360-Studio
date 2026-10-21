import { useState } from 'react';
export default function BuyerActions({name,phone,url}:{name:string;phone?:string;url:string}) {
  const [message,setMessage]=useState('');const [fallback,setFallback]=useState(false);
  async function share(){
    setMessage('');
    try{if(navigator.share){await navigator.share({title:name,text:`View ${name}`,url});return;}}
    catch(error){if(error instanceof DOMException&&error.name==='AbortError')return;}
    try{await navigator.clipboard.writeText(url);setMessage('Showroom link copied.');}
    catch{setFallback(true);setMessage('Select and copy the link below.');}
  }
  const validPhone=phone&&/^\+[1-9]\d{6,14}$/.test(phone);
  return <div className="buyer-actions"><div className="inline-actions"><button type="button" className="button secondary" onClick={()=>void share()}>Share / copy link</button>{validPhone&&<a className="button" href={`https://wa.me/${phone!.slice(1)}?text=${encodeURIComponent(`Hello, I'm interested in your ${name}. Is it still available? ${url}`)}`} target="_blank" rel="noreferrer">Contact seller on WhatsApp</a>}</div>{message&&<p role="status">{message}</p>}{fallback&&<label className="field">Showroom link<input readOnly value={url} onFocus={e=>e.currentTarget.select()}/></label>}</div>;
}
