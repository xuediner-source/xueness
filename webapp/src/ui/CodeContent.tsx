import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
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
export const CodeContent = React.memo(function CodeContent({text,path,language,tone='neutral'}:{text:string;path?:string;language?:CodeLanguage|'text';tone?:'neutral'|'add'|'remove'}) {
  const {settings,dark}=useContext(CodeSettingsContext);
  const theme=dark?settings.darkTheme:settings.lightTheme;
  const lang=language??codeLanguage(path);
  const syncH=getLoadedHighlighter(theme,lang);
  const initialHtml = useMemo(()=>{
    if(syncH&&lang!=='text'&&text.length<=200000){
      try{return syncH.codeToHtml(text,{lang,theme});}catch{return '';}
    }
    return '';
  },[syncH,text,lang,theme]);
  const [html,setHtml]=useState(initialHtml);
  useEffect(()=>{
    let live=true;
    if(lang==='text'||text.length>200000){
      setHtml('');
      return()=>{live=false;};
    }
    const currentH=getLoadedHighlighter(theme,lang);
    if(currentH){
      try{
        const val=currentH.codeToHtml(text,{lang,theme});
        if(live)setHtml(val);
      }catch{
        if(live)setHtml('');
      }
      return()=>{live=false;};
    }
    void loadHighlighter([theme],lang).then(h=>{
      if(!live)return;
      try{
        const value=h.codeToHtml(text,{lang,theme});
        if(live)setHtml(value);
      }catch{
        if(live)setHtml('');
      }
    }).catch(()=>{});
    return()=>{live=false;};
  },[text,theme,lang]);
  const props={className:`xn-code-content${settings.showLineNumbers?' has-line-numbers':''}${settings.wrapLongLines?' wraps-lines':''}`,style:{fontSize:`${settings.fontSizePx}px`},'data-testid':'primitive-code','data-tone':tone,'data-language':lang};
  const lines=text.split('\n');
  return html?<div {...props} dangerouslySetInnerHTML={{__html:html}}/>:<div {...props}><pre><code>{lines.map((line,i)=><React.Fragment key={i}><span className="line">{line||'\u200b'}</span>{i<lines.length-1?'\n':''}</React.Fragment>)}</code></pre></div>;
});
