import{r as i}from"./react-vendor-BU8zUl08.js";/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const m=(...t)=>t.filter((e,r,o)=>!!e&&e.trim()!==""&&o.indexOf(e)===r).join(" ").trim();/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const M=t=>t.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase();/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const W=t=>t.replace(/^([A-Z])|[\s-_]+(\w)/g,(e,r,o)=>o?o.toUpperCase():r.toLowerCase());/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const f=t=>{const e=W(t);return e.charAt(0).toUpperCase()+e.slice(1)};/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */var u={xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"};/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const L=t=>{for(const e in t)if(e.startsWith("aria-")||e==="role"||e==="title")return!0;return!1},B=i.createContext({}),E=()=>i.useContext(B),b=i.forwardRef(({color:t,size:e,strokeWidth:r,absoluteStrokeWidth:o,className:n="",children:s,iconNode:C,...l},g)=>{const{size:c=24,strokeWidth:d=2,absoluteStrokeWidth:w=!1,color:h="currentColor",className:y=""}=E()??{},k=o??w?Number(r??d)*24/Number(e??c):r??d;return i.createElement("svg",{ref:g,...u,width:e??c??u.width,height:e??c??u.height,stroke:t??h,strokeWidth:k,className:m("lucide",y,n),...!s&&!L(l)&&{"aria-hidden":"true"},...l},[...C.map(([x,A])=>i.createElement(x,A)),...Array.isArray(s)?s:[s]])});/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const K=(t,e)=>{const r=i.forwardRef(({className:o,...n},s)=>i.createElement(b,{ref:s,iconNode:e,className:m(`lucide-${M(f(t))}`,`lucide-${t}`,o),...n}));return r.displayName=f(t),r};function a(t){const r=(t??(typeof navigator>"u"?"":navigator.platform)).trim().toLowerCase();return r==="darwin"||r.startsWith("mac")}function j(t){const e=t??(typeof navigator>"u"?"":navigator.platform);return a(e)?"macos":e.trim().toLowerCase().startsWith("win")?"windows":"other"}function p(t,e){const r=a(e);return t.includes("|")?t.split("|").flatMap((o,n)=>[...n?[" / "]:[],...p(o.trim(),e)]):t.split("+").map(o=>o==="Mod"?r?"⌘":"Ctrl":o==="Ctrl"?"Ctrl":o==="Meta"?r?"⌘":"Win":o==="Alt"?r?"⌥":"Alt":o==="Shift"?r?"⇧":"Shift":o.startsWith("Arrow")?o.replace("Arrow",""):o)}function P(t,e){const r=a(e);return t.includes("|")?t.split("|").map(o=>P(o.trim(),e)).join(" / "):p(t,e).join(r?"":"+")}function v(t,e){return a(e)?!!(t.metaKey&&!t.ctrlKey):!!(t.ctrlKey&&!t.metaKey)}function z(t){typeof queueMicrotask=="function"?queueMicrotask(t):setTimeout(t,0)}function $(t){var o,n;if(!t)return!1;const e=t.target,r=!!(e&&typeof e.closest=="function"&&e.closest("[data-composing='true']"));return!!(t.compositionActive||r||t.isComposing||(o=t.nativeEvent)!=null&&o.isComposing||t.keyCode===229||((n=t.nativeEvent)==null?void 0:n.keyCode)===229||t.key==="Process"||t.key==="Dead")}export{p as a,P as b,K as c,z as d,v as e,a as f,$ as i,j as r};
