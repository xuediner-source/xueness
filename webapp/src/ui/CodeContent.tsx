import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getLoadedHighlighter, isCodePreviewTheme, loadHighlighter, type CodeLanguage, type CodePreviewTheme } from './CodePreview';
import './code-content.css';
export type CodeDisplaySettings = { lightTheme:CodePreviewTheme;darkTheme:CodePreviewTheme;showLineNumbers:boolean;wrapLongLines:boolean;fontSizePx:number };
export function normalizeCodeSettings(value: unknown): CodeDisplaySettings {
  const s = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {lightTheme:isCodePreviewTheme(s.lightTheme)?s.lightTheme:'github-light',darkTheme:isCodePreviewTheme(s.darkTheme)?s.darkTheme:'github-dark',showLineNumbers:s.showLineNumbers!==false,wrapLongLines:s.wrapLongLines===true,fontSizePx:Math.min(20,Math.max(12,Number(s.fontSizePx)||12))};
}
const CodeSettingsContext = createContext<{settings:CodeDisplaySettings;dark:boolean}>({settings:normalizeCodeSettings(null),dark:false});
export function CodeDisplayProvider({children,settings,dark}:{children:React.ReactNode;settings:unknown;dark:boolean}) {
  const normalized = useMemo(() => normalizeCodeSettings(settings), [
    typeof settings === 'object' && settings !== null ? JSON.stringify(settings) : settings,
  ]);
  const value = useMemo(() => ({ settings: normalized, dark }), [normalized, dark]);
  return <CodeSettingsContext.Provider value={value}>{children}</CodeSettingsContext.Provider>;
}
export function codeLanguage(path?: string): CodeLanguage | 'text' {
  const ext=path?.split('.').pop()?.toLowerCase();
  return ({ts:'typescript',tsx:'tsx',js:'javascript',mjs:'javascript',cjs:'javascript',jsx:'jsx',py:'python',json:'json',css:'css',html:'html',htm:'html',sh:'bash',zsh:'bash',bash:'bash',yml:'yaml',yaml:'yaml',md:'markdown',diff:'diff',patch:'diff',rs:'rust',go:'go',c:'cpp',h:'cpp',cpp:'cpp',hpp:'cpp',sql:'sql'} as Record<string,CodeLanguage>)[ext??'']??'text';
}
export type CodeHighlightTiming = 'immediate' | 'on-visible' | 'after-stream';
/** When highlight work may run: immediately, once the block has entered the
 * viewport, or never while its text is still streaming (the caller flips the
 * timing once the stream settles). */
export function shouldAttemptCodeHighlight(timing: CodeHighlightTiming, visibleOnce: boolean): boolean {
  return timing === 'immediate' || (timing === 'on-visible' && visibleOnce);
}
export const CodeContent = React.memo(function CodeContent({text,path,language,tone='neutral',highlightTiming='immediate'}:{text:string;path?:string;language?:CodeLanguage|'text';tone?:'neutral'|'add'|'remove';highlightTiming?:CodeHighlightTiming}) {
  const {settings,dark}=useContext(CodeSettingsContext);
  const theme=dark?settings.darkTheme:settings.lightTheme;
  const lang=language??codeLanguage(path);
  const rootRef=useRef<HTMLDivElement|null>(null);
  // Without IntersectionObserver there is no viewport to wait for; treat the
  // block as visible so behavior falls back to highlighting immediately.
  const [visibleOnce,setVisibleOnce]=useState(typeof IntersectionObserver==='undefined');
  useEffect(()=>{
    if(visibleOnce||highlightTiming!=='on-visible') return;
    const node=rootRef.current;
    if(!node||typeof IntersectionObserver==='undefined'){setVisibleOnce(true);return;}
    const observer=new IntersectionObserver(entries=>{
      if(entries.some(entry=>entry.isIntersecting)){setVisibleOnce(true);observer.disconnect();}
    },{rootMargin:'160px 0px'});
    observer.observe(node);
    return()=>observer.disconnect();
  },[highlightTiming,visibleOnce]);
  // Highlight at most once per text/language/theme change, during render; the
  // effect only loads a missing theme or grammar and then re-renders.
  const eligible=lang!=='text'&&text.length<=200000&&shouldAttemptCodeHighlight(highlightTiming,visibleOnce);
  const h=eligible?getLoadedHighlighter(theme,lang):null;
  const [,setLoads]=useState(0);
  useEffect(()=>{
    if(!eligible||h) return;
    let live=true;
    loadHighlighter([theme],lang as CodeLanguage).then(()=>{if(live)setLoads(n=>n+1);},()=>{});
    return()=>{live=false;};
  },[eligible,h,theme,lang]);
  // While that load runs, keep the last highlight of the same text (e.g. across
  // a theme switch) rather than flashing plain text.
  const last=useRef(['','']);
  const html=useMemo(()=>{
    let value='';
    if(h){try{value=h.codeToHtml(text,{lang,theme});}catch{}}
    else if(eligible&&last.current[0]===text) value=last.current[1];
    last.current=[text,value];
    return value;
  },[h,text,lang,theme,eligible]);
  const props={className:`xn-code-content${settings.showLineNumbers?' has-line-numbers':''}${settings.wrapLongLines?' wraps-lines':''}`,style:{fontSize:`${settings.fontSizePx}px`},'data-testid':'primitive-code','data-tone':tone,'data-language':lang,'data-highlight-timing':highlightTiming};
  const lines=text.split('\n');
  return html?<div ref={rootRef} {...props} dangerouslySetInnerHTML={{__html:html}}/>:<div ref={rootRef} {...props}><pre><code>{lines.map((line,i)=><React.Fragment key={i}><span className="line">{line||'\u200b'}</span>{i<lines.length-1?'\n':''}</React.Fragment>)}</code></pre></div>;
});
