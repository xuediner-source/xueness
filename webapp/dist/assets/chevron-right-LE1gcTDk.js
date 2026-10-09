import{r as i}from"./react-vendor-DPCyJGN7.js";(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const s of document.querySelectorAll('link[rel="modulepreload"]'))r(s);new MutationObserver(s=>{for(const n of s)if(n.type==="childList")for(const a of n.addedNodes)a.tagName==="LINK"&&a.rel==="modulepreload"&&r(a)}).observe(document,{childList:!0,subtree:!0});function o(s){const n={};return s.integrity&&(n.integrity=s.integrity),s.referrerPolicy&&(n.referrerPolicy=s.referrerPolicy),s.crossOrigin==="use-credentials"?n.credentials="include":s.crossOrigin==="anonymous"?n.credentials="omit":n.credentials="same-origin",n}function r(s){if(s.ep)return;s.ep=!0;const n=o(s);fetch(s.href,n)}})();function c(e){const o=(e??(typeof navigator>"u"?"":navigator.platform)).trim().toLowerCase();return o==="darwin"||o.startsWith("mac")}function K(e){const t=e??(typeof navigator>"u"?"":navigator.platform);return c(t)?"macos":t.trim().toLowerCase().startsWith("win")?"windows":"other"}function L(e,t){const o=c(t);return e.split("+").map(r=>r==="Mod"?o?"⌘":"Ctrl":r==="Ctrl"?"Ctrl":r==="Meta"?o?"⌘":"Win":r==="Alt"?o?"⌥":"Alt":r==="Shift"?o?"⇧":"Shift":r.startsWith("Arrow")?r.replace("Arrow",""):r)}function O(e,t){const o=c(t);return L(e,t).join(o?"":"+")}function N(e,t){return c(t)?!!(e.metaKey&&!e.ctrlKey):!!(e.ctrlKey&&!e.metaKey)}function q(e){typeof queueMicrotask=="function"?queueMicrotask(e):setTimeout(e,0)}function z(e){var r,s;if(!e)return!1;const t=e.target,o=!!(t&&typeof t.closest=="function"&&t.closest("[data-composing='true']"));return!!(e.compositionActive||o||e.isComposing||(r=e.nativeEvent)!=null&&r.isComposing||e.keyCode===229||((s=e.nativeEvent)==null?void 0:s.keyCode)===229||e.key==="Process"||e.key==="Dead")}/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const p=(...e)=>e.filter((t,o,r)=>!!t&&t.trim()!==""&&r.indexOf(t)===o).join(" ").trim();/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const k=e=>e.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase();/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const M=e=>e.replace(/^([A-Z])|[\s-_]+(\w)/g,(t,o,r)=>r?r.toUpperCase():o.toLowerCase());/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const m=e=>{const t=M(e);return t.charAt(0).toUpperCase()+t.slice(1)};/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */var l={xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"};/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const P=e=>{for(const t in e)if(t.startsWith("aria-")||t==="role"||t==="title")return!0;return!1},W=i.createContext({}),b=()=>i.useContext(W),E=i.forwardRef(({color:e,size:t,strokeWidth:o,absoluteStrokeWidth:r,className:s="",children:n,iconNode:a,...f},h)=>{const{size:u=24,strokeWidth:d=2,absoluteStrokeWidth:g=!1,color:C="currentColor",className:y=""}=b()??{},w=r??g?Number(o??d)*24/Number(t??u):o??d;return i.createElement("svg",{ref:h,...l,width:t??u??l.width,height:t??u??l.height,stroke:e??C,strokeWidth:w,className:p("lucide",y,s),...!n&&!P(f)&&{"aria-hidden":"true"},...f},[...a.map(([x,A])=>i.createElement(x,A)),...Array.isArray(n)?n:[n]])});/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const v=(e,t)=>{const o=i.forwardRef(({className:r,...s},n)=>i.createElement(E,{ref:n,iconNode:t,className:p(`lucide-${k(m(e))}`,`lucide-${e}`,r),...s}));return o.displayName=m(e),o};/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const B=[["path",{d:"m9 18 6-6-6-6",key:"mthhwq"}]],I=v("chevron-right",B);export{I as C,O as a,N as b,v as c,L as d,q as e,c as f,z as i,K as r};
