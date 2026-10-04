import{r as c}from"./react-vendor-DPCyJGN7.js";(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const t of document.querySelectorAll('link[rel="modulepreload"]'))n(t);new MutationObserver(t=>{for(const r of t)if(r.type==="childList")for(const i of r.addedNodes)i.tagName==="LINK"&&i.rel==="modulepreload"&&n(i)}).observe(document,{childList:!0,subtree:!0});function s(t){const r={};return t.integrity&&(r.integrity=t.integrity),t.referrerPolicy&&(r.referrerPolicy=t.referrerPolicy),t.crossOrigin==="use-credentials"?r.credentials="include":t.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function n(t){if(t.ep)return;t.ep=!0;const r=s(t);fetch(t.href,r)}})();/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const h=(...o)=>o.filter((e,s,n)=>!!e&&e.trim()!==""&&n.indexOf(e)===s).join(" ").trim();/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const L=o=>o.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase();/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const b=o=>o.replace(/^([A-Z])|[\s-_]+(\w)/g,(e,s,n)=>n?n.toUpperCase():s.toLowerCase());/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const f=o=>{const e=b(o);return e.charAt(0).toUpperCase()+e.slice(1)};/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */var l={xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"};/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const A=o=>{for(const e in o)if(e.startsWith("aria-")||e==="role"||e==="title")return!0;return!1},v=c.createContext({}),O=()=>c.useContext(v),W=c.forwardRef(({color:o,size:e,strokeWidth:s,absoluteStrokeWidth:n,className:t="",children:r,iconNode:i,...u},p)=>{const{size:a=24,strokeWidth:d=2,absoluteStrokeWidth:m=!1,color:C="currentColor",className:g=""}=O()??{},w=n??m?Number(s??d)*24/Number(e??a):s??d;return c.createElement("svg",{ref:p,...l,width:e??a??l.width,height:e??a??l.height,stroke:o??C,strokeWidth:w,className:h("lucide",g,t),...!r&&!A(u)&&{"aria-hidden":"true"},...u},[...i.map(([y,x])=>c.createElement(y,x)),...Array.isArray(r)?r:[r]])});/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const k=(o,e)=>{const s=c.forwardRef(({className:n,...t},r)=>c.createElement(W,{ref:r,iconNode:e,className:h(`lucide-${L(f(o))}`,`lucide-${o}`,n),...t}));return s.displayName=f(o),s};/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const N=[["path",{d:"m9 18 6-6-6-6",key:"mthhwq"}]],S=k("chevron-right",N);export{S as C,k as c};
