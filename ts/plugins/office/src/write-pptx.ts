/**
 * PPTX writer mirroring `_make_pptx` on python-pptx's default 4:3 template:
 * one blank-layout slide per item, a 26 pt bold title text box and stacked
 * 16 pt body text boxes at the same EMU positions, `\n`/`\v` as line breaks
 * and other C0 controls as `_xHHHH_` escapes.
 */
import { appProperties, contentTypes, coreProperties, CT, packageRels, REL, relationships, requireXml, textElement, XML_DECL } from "./ooxml-write.ts";
import { writeZip } from "./zip.ts";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main", P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS = `xmlns:a="${A}" xmlns:p="${P}" xmlns:r="${REL}"`;
const EMU = 914400, SLIDE_W = 9144000, SLIDE_H = 6858000;
const inches = (value: number): number => Math.trunc(value * EMU);

export interface PptxDocument { title: string; slides: Array<{ title: string; paragraphs: string[]; bullets: string[] }> }

function paragraphText(text: string): string {
  let out = "", chunk = "";
  const flush = (): void => { if (chunk) out += `<a:r>${textElement("a:t", chunk).replace(' xml:space="preserve"', "")}</a:r>`; chunk = ""; };
  for (const char of text) {
    if (char === "\n" || char === "\v") { flush(); out += "<a:br/>"; }
    else if (/[\u0000-\u0008\u000c-\u001f]/.test(char)) chunk += `_x${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`;
    else chunk += char;
  }
  flush();
  return out;
}

function textBox(id: number, x: number, y: number, cx: number, cy: number, wrap: string, rPr: string, text: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id - 1}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="${wrap}"><a:spAutoFit/></a:bodyPr><a:lstStyle/><a:p><a:pPr><a:defRPr ${rPr}/></a:pPr>${paragraphText(text)}</a:p></p:txBody></p:sp>`;
}

function slideXml(slide: PptxDocument["slides"][number]): string {
  const shapes: string[] = [];
  let id = 2;
  if (slide.title) shapes.push(textBox(id++, inches(0.55), inches(0.35), SLIDE_W - inches(1.1), inches(0.9), "none", 'sz="2600" b="1"', slide.title));
  const blocks: Array<[string, boolean]> = [...slide.paragraphs.map((t): [string, boolean] => [t, false]), ...slide.bullets.map((t): [string, boolean] => [t, true])];
  let y = 1.5;
  for (const [text, bullet] of blocks) {
    const lines = Math.max(1, Math.ceil([...text].length / 50)), height = Math.min(1.5, 0.28 * lines);
    shapes.push(textBox(id++, inches(0.7), inches(y), SLIDE_W - inches(1.4), inches(height), "square", 'sz="1600"', (bullet ? "• " : "") + text));
    y += height + 0.04;
    if (y > 7.15) throw new Error("slide content exceeds the bounded text layout");
  }
  return `${XML_DECL}<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const EMPTY_TREE = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>';
const CLR = [["dk1", '<a:sysClr val="windowText" lastClr="000000"/>'], ["lt1", '<a:sysClr val="window" lastClr="FFFFFF"/>'], ["dk2", '<a:srgbClr val="1F497D"/>'], ["lt2", '<a:srgbClr val="EEECE1"/>'],
  ["accent1", '<a:srgbClr val="4F81BD"/>'], ["accent2", '<a:srgbClr val="C0504D"/>'], ["accent3", '<a:srgbClr val="9BBB59"/>'], ["accent4", '<a:srgbClr val="8064A2"/>'],
  ["accent5", '<a:srgbClr val="4BACC6"/>'], ["accent6", '<a:srgbClr val="F79646"/>'], ["hlink", '<a:srgbClr val="0000FF"/>'], ["folHlink", '<a:srgbClr val="800080"/>']];
const FILL = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>', LINE = '<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>';
const THEME = `${XML_DECL}<a:theme xmlns:a="${A}" name="Office Theme"><a:themeElements><a:clrScheme name="Office">${CLR.map(([n, v]) => `<a:${n}>${v}</a:${n}>`).join("")}</a:clrScheme>` +
  `<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
  `<a:fmtScheme name="Office"><a:fillStyleLst>${FILL.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${LINE.repeat(3)}</a:lnStyleLst><a:effectStyleLst>${"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${FILL.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
const CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

export function makePptx(document: PptxDocument): Buffer {
  requireXml(document.title);
  requireXml(...document.slides.flatMap((s) => [s.title, ...s.paragraphs, ...s.bullets]).map((t) => t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")));
  const slides = document.slides.map(slideXml);
  const files: Array<[string, string]> = [
    ["[Content_Types].xml", contentTypes([
      ["/ppt/presentation.xml", `${CT}.presentationml.presentation.main+xml`], ["/ppt/slideMasters/slideMaster1.xml", `${CT}.presentationml.slideMaster+xml`],
      ["/ppt/slideLayouts/slideLayout1.xml", `${CT}.presentationml.slideLayout+xml`], ["/ppt/theme/theme1.xml", `${CT}.theme+xml`],
      ["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"], ["/docProps/app.xml", `${CT}.extended-properties+xml`],
      ...slides.map((_s, i): [string, string] => [`/ppt/slides/slide${i + 1}.xml`, `${CT}.presentationml.slide+xml`])])],
    ["_rels/.rels", packageRels("ppt/presentation.xml")],
    ["docProps/core.xml", coreProperties(document.title, "Xueness")],
    ["docProps/app.xml", appProperties("Xueness")],
    ["ppt/presentation.xml", `${XML_DECL}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_s, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}" type="screen4x3"/><p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/></p:presentation>`],
    ["ppt/_rels/presentation.xml.rels", relationships([["rId1", `${REL}/slideMaster`, "slideMasters/slideMaster1.xml"], ["rId2", `${REL}/theme`, "theme/theme1.xml"], ...slides.map((_s, i): [string, string, string] => [`rId${i + 3}`, `${REL}/slide`, `slides/slide${i + 1}.xml`])])],
    ["ppt/slideMasters/slideMaster1.xml", `${XML_DECL}<p:sldMaster ${NS}><p:cSld>${EMPTY_TREE}</p:cSld>${CLR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`],
    ["ppt/slideMasters/_rels/slideMaster1.xml.rels", relationships([["rId1", `${REL}/slideLayout`, "../slideLayouts/slideLayout1.xml"], ["rId2", `${REL}/theme`, "../theme/theme1.xml"]])],
    ["ppt/slideLayouts/slideLayout1.xml", `${XML_DECL}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">${EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`],
    ["ppt/slideLayouts/_rels/slideLayout1.xml.rels", relationships([["rId1", `${REL}/slideMaster`, "../slideMasters/slideMaster1.xml"]])],
    ["ppt/theme/theme1.xml", THEME],
    ...slides.flatMap((xml, i): Array<[string, string]> => [[`ppt/slides/slide${i + 1}.xml`, xml], [`ppt/slides/_rels/slide${i + 1}.xml.rels`, relationships([["rId1", `${REL}/slideLayout`, "../slideLayouts/slideLayout1.xml"]])]]),
  ];
  return writeZip(files.map(([name, text]) => ({ name, data: Buffer.from(text, "utf8") })));
}
