import{r as i}from"./react-vendor-Ca5gwkdN.js";/**
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
 */const L=t=>{for(const e in t)if(e.startsWith("aria-")||e==="role"||e==="title")return!0;return!1},B=i.createContext({}),E=()=>i.useContext(B),b=i.forwardRef(({color:t,size:e,strokeWidth:r,absoluteStrokeWidth:o,className:n="",children:s,iconNode:p,...l},h)=>{const{size:c=24,strokeWidth:d=2,absoluteStrokeWidth:g=!1,color:w="currentColor",className:y=""}=E()??{},k=o??g?Number(r??d)*24/Number(e??c):r??d;return i.createElement("svg",{ref:h,...u,width:e??c??u.width,height:e??c??u.height,stroke:t??w,strokeWidth:k,className:m("lucide",y,n),...!s&&!L(l)&&{"aria-hidden":"true"},...l},[...p.map(([x,A])=>i.createElement(x,A)),...Array.isArray(s)?s:[s]])});/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const P=(t,e)=>{const r=i.forwardRef(({className:o,...n},s)=>i.createElement(b,{ref:s,iconNode:e,className:m(`lucide-${M(f(t))}`,`lucide-${t}`,o),...n}));return r.displayName=f(t),r};/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const S=[["path",{d:"m9 18 6-6-6-6",key:"mthhwq"}]],j=P("chevron-right",S);function a(t){const r=(t??(typeof navigator>"u"?"":navigator.platform)).trim().toLowerCase();return r==="darwin"||r.startsWith("mac")}function z(t){const e=t??(typeof navigator>"u"?"":navigator.platform);return a(e)?"macos":e.trim().toLowerCase().startsWith("win")?"windows":"other"}function C(t,e){const r=a(e);return t.includes("|")?t.split("|").flatMap((o,n)=>[...n?[" / "]:[],...C(o.trim(),e)]):t.split("+").map(o=>o==="Mod"?r?"⌘":"Ctrl":o==="Ctrl"?"Ctrl":o==="Meta"?r?"⌘":"Win":o==="Alt"?r?"⌥":"Alt":o==="Shift"?r?"⇧":"Shift":o.startsWith("Arrow")?o.replace("Arrow",""):o)}function v(t,e){const r=a(e);return t.includes("|")?t.split("|").map(o=>v(o.trim(),e)).join(" / "):C(t,e).join(r?"":"+")}function $(t,e){return a(e)?!!(t.metaKey&&!t.ctrlKey):!!(t.ctrlKey&&!t.metaKey)}function q(t){typeof queueMicrotask=="function"?queueMicrotask(t):setTimeout(t,0)}function I(t){var o,n;if(!t)return!1;const e=t.target,r=!!(e&&typeof e.closest=="function"&&e.closest("[data-composing='true']"));return!!(t.compositionActive||r||t.isComposing||(o=t.nativeEvent)!=null&&o.isComposing||t.keyCode===229||((n=t.nativeEvent)==null?void 0:n.keyCode)===229||t.key==="Process"||t.key==="Dead")}export{j as C,C as a,v as b,P as c,q as d,a as e,$ as f,I as i,z as r};
