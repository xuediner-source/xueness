import{j as t}from"./react-vendor-Ca5gwkdN.js";import{t as a}from"./workbench-B2iKYeIq.js";import{bi as m}from"./App-BaQFKp6F.js";import{c as r}from"./xuenessShortcutDisplay-CUphYLRM.js";import{W as c}from"./wand-sparkles-B0vr3JbD.js";import"./_commonjsHelpers-Cpj98o6Y.js";import"./modulepreload-polyfill-B5Qt9EMX.js";import"./radix-vendor-DphSHhpH.js";import"./Combination-S-O8X2Og.js";import"./markdown-vendor-BuqhfVJP.js";import"./index-DMIU-JKF.js";/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const l=[["path",{d:"M7 7h10v10",key:"1tivn9"}],["path",{d:"M7 17 17 7",key:"1vkiza"}]],h=r("arrow-up-right",l);/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const x=[["path",{d:"M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18",key:"gugj83"}]],u=r("table-2",x),j=[{id:"understand",Icon:m,title:"看懂一份资料",detail:"抓重点，解释术语，给出下一步",prompt:"请帮我读懂接下来附上的资料。我是新手，请先用三句话说明重点，再解释必要的术语，最后告诉我可以怎么做。"},{id:"organize",Icon:u,title:"整理一张表格",detail:"清理数据，算出结果，保存新文件",prompt:"请帮我整理接下来附上的表格：找出重复或缺失的数据，汇总关键数字，把结果保存为一个新文件，并告诉我改了什么。"},{id:"create",Icon:c,title:"做出一个小工具",detail:"从想法开始，一起做出可用的成果",prompt:"我想做一个帮我解决日常问题的小工具。我没有编程经验，请先问我最想解决什么问题，再帮我一步步做出可用的版本。"}];function w({onSelect:i,disabled:o=!1}){return t.jsx("div",{className:"xn-starter-ideas",role:"group","aria-label":a("从一个想法开始"),"data-testid":"starter-ideas",children:j.map(({id:e,Icon:s,title:n,detail:d,prompt:p})=>t.jsxs("button",{type:"button","data-testid":`starter-idea-${e}`,disabled:o,onClick:()=>i(a(p)),children:[t.jsxs("span",{className:"xn-starter-ideas__top",children:[t.jsx(s,{size:17,"aria-hidden":"true"}),t.jsx(h,{size:14,"aria-hidden":"true"})]}),t.jsx("strong",{children:a(n)}),t.jsx("span",{className:"xn-starter-ideas__detail",children:a(d)})]},e))})}export{w as StarterIdeas};
