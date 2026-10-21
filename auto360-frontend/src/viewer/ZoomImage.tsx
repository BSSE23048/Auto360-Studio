import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './viewer.css';

/** Transforms the image and its normalized overlays together; never alters image bytes. */
export default function ZoomImage({src,alt,original=false,onStep,children}:{src:string;alt:string;original?:boolean;onStep?:(delta:number)=>void;children?:ReactNode}) {
  const host=useRef<HTMLDivElement>(null);
  const [box,setBox]=useState({w:1,h:1});const [natural,setNatural]=useState({w:1,h:1});
  const [view,setView]=useState({z:1,x:0,y:0});const [active,setActive]=useState(false);const [error,setError]=useState(false);
  const points=useRef(new Map<number,{x:number;y:number}>());const distance=useRef(0);const drag=useRef(0);const tap=useRef({time:0,x:0,y:0});const moved=useRef(false);
  const fit=Math.min(box.w/natural.w,box.h/natural.h,original?1:Infinity);
  const w=natural.w*fit,h=natural.h*fit;const max=original?Math.max(1,1/fit):4;
  const clamp=(z:number,x:number,y:number)=>({z:Math.max(1,Math.min(max,z)),x:Math.max(-Math.max(0,(w*z-box.w)/2),Math.min(Math.max(0,(w*z-box.w)/2),x)),y:Math.max(-Math.max(0,(h*z-box.h)/2),Math.min(Math.max(0,(h*z-box.h)/2),y))});
  const zoom=(z:number)=>setView(v=>clamp(Math.max(1,Math.min(max,z)),v.x,v.y));
  useLayoutEffect(()=>{const node=host.current;if(!node)return;const observer=new ResizeObserver(([entry])=>setBox({w:entry.contentRect.width,h:entry.contentRect.height}));observer.observe(node);return()=>observer.disconnect();},[]);
  useLayoutEffect(()=>{setView({z:1,x:0,y:0});setError(false);},[src]);
  useLayoutEffect(()=>{setView(v=>clamp(Math.min(v.z,max),v.x,v.y));},[box.w,box.h,natural.w,natural.h]);
  useLayoutEffect(()=>{const node=host.current;if(!node||!active)return;const wheel=(event:WheelEvent)=>{event.preventDefault();zoom(view.z*(event.deltaY<0?1.15:1/1.15));};node.addEventListener('wheel',wheel,{passive:false});return()=>node.removeEventListener('wheel',wheel);},[active,view.z,max,w,h,box.w,box.h]);
  return <><div className="car-canvas" ref={host} tabIndex={0} role="region" aria-label={alt+'. Use arrow keys to navigate; enable touch zoom for pinch and pan.'} style={{touchAction:active?'none':'pan-y'}}
    onKeyDown={e=>{if(e.target!==e.currentTarget)return;if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();onStep?.(e.key==='ArrowLeft'?-1:1);}if(e.key==='+'||e.key==='='){setActive(true);zoom(view.z*1.5);}if(e.key==='-')zoom(view.z/1.5);if(e.key==='0')setView({z:1,x:0,y:0});}}
    onPointerDown={e=>{if(e.button!==0||e.target instanceof Element&&e.target.closest('button'))return;e.currentTarget.setPointerCapture(e.pointerId);points.current.set(e.pointerId,{x:e.clientX,y:e.clientY});moved.current=false;drag.current=0;distance.current=0;}}
    onPointerMove={e=>{const previous=points.current.get(e.pointerId);if(!previous)return;const dx=e.clientX-previous.x,dy=e.clientY-previous.y;points.current.set(e.pointerId,{x:e.clientX,y:e.clientY});if(Math.abs(dx)+Math.abs(dy)>2)moved.current=true;
      if(points.current.size===2&&active){moved.current=true;const[a,b]=[...points.current.values()];const d=Math.hypot(a.x-b.x,a.y-b.y);if(distance.current)zoom(view.z*d/distance.current);distance.current=d;return;}
      if(view.z>1&&active)setView(v=>clamp(v.z,v.x+dx,v.y+dy));else if(onStep&&!active){drag.current+=dx;const threshold=Math.max(18,box.w/14);const steps=Math.trunc(drag.current/threshold);if(steps){onStep(-steps);drag.current-=steps*threshold;}}
    }}
    onPointerUp={e=>{points.current.delete(e.pointerId);distance.current=0;if(!moved.current){const now=Date.now();if(now-tap.current.time<320&&Math.hypot(e.clientX-tap.current.x,e.clientY-tap.current.y)<30){setActive(true);zoom(view.z>1?1:Math.min(max,2));tap.current.time=0;}else tap.current={time:now,x:e.clientX,y:e.clientY};}}}
    onPointerCancel={()=>{points.current.clear();distance.current=0;}} onLostPointerCapture={e=>points.current.delete(e.pointerId)}>
    <div className="car-image-plane" style={{width:w,height:h,transform:`translate(-50%,-50%) translate(${view.x}px,${view.y}px) scale(${view.z})`}}>
      <img src={src} alt={alt} draggable={false} onLoad={e=>setNatural({w:e.currentTarget.naturalWidth,h:e.currentTarget.naturalHeight})} onError={()=>setError(true)}/>{children}
    </div>{error&&<p className="car-status" role="alert">This browser cannot display this image. Download the original to use a compatible app.</p>}
  </div><div className="car-toolbar"><button type="button" className="button secondary" aria-pressed={active} onClick={()=>{setActive(!active);setView({z:1,x:0,y:0});}}>{active?'Finish touch zoom':'Enable touch zoom'}</button><button type="button" className="icon-button" aria-label="Zoom out" disabled={view.z<=1} onClick={()=>zoom(view.z/1.5)}>−</button><button type="button" className="icon-button" aria-label="Zoom in" disabled={view.z>=max} onClick={()=>{setActive(true);zoom(view.z*1.5);}}>+</button><button type="button" className="button secondary" onClick={()=>setView({z:1,x:0,y:0})}>Reset</button>{original&&<button type="button" className="button secondary" onClick={()=>{setActive(true);zoom(max);}}>Actual pixels</button>}</div><p className="muted car-caption">{original?`${natural.w>1?`${natural.w} × ${natural.h} · `:''}Original pixels; no enhancement.`:'Lightweight preview. Inspect original for fine detail.'} {active?'Pinch, double-tap or drag to inspect.':'Page scrolling is enabled. Double-tap or enable touch zoom to inspect.'}</p></>;
}
