import { useEffect, useState } from 'react';
export default function ConnectionNotice(){
  const [offline,setOffline]=useState(!navigator.onLine);
  useEffect(()=>{const update=()=>setOffline(!navigator.onLine);window.addEventListener('online',update);window.addEventListener('offline',update);return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};},[]);
  return offline?<div className="offline-notice" role="status">You’re offline. Saved drafts remain stored; cloud changes need a connection. Reconnect before retrying.</div>:null;
}
