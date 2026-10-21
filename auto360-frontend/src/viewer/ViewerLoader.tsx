import { Component, lazy, Suspense, type ComponentProps, type ReactNode } from 'react';
const Viewer=lazy(()=>import('./CarViewer'));
class ViewerBoundary extends Component<{children:ReactNode},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<div className="notice" role="alert">The viewer could not open. Check your connection, then <button type="button" className="button secondary" onClick={()=>location.reload()}>Reload</button>.</div>:this.props.children;}
}
export default function ViewerLoader(props:ComponentProps<typeof Viewer>){return <ViewerBoundary><Suspense fallback={<div className="viewer-skeleton" role="status" aria-label="Loading photo viewer"><span>Opening photo viewer…</span></div>}><Viewer {...props}/></Suspense></ViewerBoundary>;}
