import{r as s}from"./react-vendor-DPCyJGN7.js";(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const n of document.querySelectorAll('link[rel="modulepreload"]'))o(n);new MutationObserver(n=>{for(const i of n)if(i.type==="childList")for(const a of i.addedNodes)a.tagName==="LINK"&&a.rel==="modulepreload"&&o(a)}).observe(document,{childList:!0,subtree:!0});function r(n){const i={};return n.integrity&&(i.integrity=n.integrity),n.referrerPolicy&&(i.referrerPolicy=n.referrerPolicy),n.crossOrigin==="use-credentials"?i.credentials="include":n.crossOrigin==="anonymous"?i.credentials="omit":i.credentials="same-origin",i}function o(n){if(n.ep)return;n.ep=!0;const i=r(n);fetch(n.href,i)}})();function c(e){const r=(e??(typeof navigator>"u"?"":navigator.platform)).trim().toLowerCase();return r==="darwin"||r.startsWith("mac")}function O(e){const t=e??(typeof navigator>"u"?"":navigator.platform);return c(t)?"macos":t.trim().toLowerCase().startsWith("win")?"windows":"other"}function p(e,t){const r=c(t);return e.includes("|")?e.split("|").flatMap((o,n)=>[...n?[" / "]:[],...p(o.trim(),t)]):e.split("+").map(o=>o==="Mod"?r?"⌘":"Ctrl":o==="Ctrl"?"Ctrl":o==="Meta"?r?"⌘":"Win":o==="Alt"?r?"⌥":"Alt":o==="Shift"?r?"⇧":"Shift":o.startsWith("Arrow")?o.replace("Arrow",""):o)}function M(e,t){const r=c(t);return e.includes("|")?e.split("|").map(o=>M(o.trim(),t)).join(" / "):p(e,t).join(r?"":"+")}function N(e,t){return c(t)?!!(e.metaKey&&!e.ctrlKey):!!(e.ctrlKey&&!e.metaKey)}function j(e){typeof queueMicrotask=="function"?queueMicrotask(e):setTimeout(e,0)}function q(e){var o,n;if(!e)return!1;const t=e.target,r=!!(t&&typeof t.closest=="function"&&t.closest("[data-composing='true']"));return!!(e.compositionActive||r||e.isComposing||(o=e.nativeEvent)!=null&&o.isComposing||e.keyCode===229||((n=e.nativeEvent)==null?void 0:n.keyCode)===229||e.key==="Process"||e.key==="Dead")}/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const h=(...e)=>e.filter((t,r,o)=>!!t&&t.trim()!==""&&o.indexOf(t)===r).join(" ").trim();/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const k=e=>e.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase();/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const P=e=>e.replace(/^([A-Z])|[\s-_]+(\w)/g,(t,r,o)=>o?o.toUpperCase():r.toLowerCase());/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const m=e=>{const t=P(e);return t.charAt(0).toUpperCase()+t.slice(1)};/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */var l={xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"};/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const W=e=>{for(const t in e)if(t.startsWith("aria-")||t==="role"||t==="title")return!0;return!1},b=s.createContext({}),E=()=>s.useContext(b),v=s.forwardRef(({color:e,size:t,strokeWidth:r,absoluteStrokeWidth:o,className:n="",children:i,iconNode:a,...f},g)=>{const{size:u=24,strokeWidth:d=2,absoluteStrokeWidth:C=!1,color:y="currentColor",className:w=""}=E()??{},x=o??C?Number(r??d)*24/Number(t??u):r??d;return s.createElement("svg",{ref:g,...l,width:t??u??l.width,height:t??u??l.height,stroke:e??y,strokeWidth:x,className:h("lucide",w,n),...!i&&!W(f)&&{"aria-hidden":"true"},...f},[...a.map(([A,L])=>s.createElement(A,L)),...Array.isArray(i)?i:[i]])});/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const B=(e,t)=>{const r=s.forwardRef(({className:o,...n},i)=>s.createElement(v,{ref:i,iconNode:t,className:h(`lucide-${k(m(e))}`,`lucide-${e}`,o),...n}));return r.displayName=m(e),r};/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const S=[["path",{d:"m9 18 6-6-6-6",key:"mthhwq"}]],z=B("chevron-right",S);export{z as C,p as a,M as b,B as c,j as d,N as e,c as f,q as i,O as r};
