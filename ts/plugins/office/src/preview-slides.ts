/** PPTX part of Python `office_preview.preview_bytes`. */
import { pyInt } from "@xueness/contracts";
import { find, findall, joinedText, type XmlElement } from "./xml.ts";
import { boundedText, dirname, HEX6, isDigits, NS, R_EMBED, type ImageBudget, type Package, type Row, type Truncation } from "./preview-common.ts";

function drawingRuns(element: XmlElement, truncation: Truncation): Row[] {
  const runs: Row[] = [];
  for (const run of findall(element, ".//a:r", NS)) {
    const text = joinedText(run, ".//a:t", NS);
    if (!text) continue;
    const props = find(run, "a:rPr", NS), style: Row = {};
    if (props) {
      if (props.attrib.b === "1") style.bold = true;
      if (props.attrib.i === "1") style.italic = true;
      if (props.attrib.u !== undefined && props.attrib.u !== "none") style.underline = true;
      if (isDigits(props.attrib.sz)) style.fontSize = Math.min(48, Math.max(6, pyInt(props.attrib.sz) / 100));
      const color = find(props, "a:solidFill/a:srgbClr", NS);
      if (color && HEX6.test(color.attrib.val ?? "")) style.color = "#" + color.attrib.val;
    }
    runs.push({ text: boundedText(text, truncation), style });
  }
  return runs;
}

/** `int(value)` or a thrown error, as `int(attrib['x'])` raises KeyError/ValueError. */
const integer = (value: string | undefined): number => { if (value === undefined) throw new Error("KeyError"); return pyInt(value); };

const SLIDE_NAME = /^ppt\/slides\/slide\p{Nd}+\.xml$/u;

export function previewSlides(pkg: Package, truncation: Truncation, budget: ImageBudget): { sections: Row[]; truncated: boolean } {
  let truncated = false;
  const sections: Row[] = [];
  const number = (name: string): number => pyInt(/slide(\p{Nd}+)/u.exec(name)![1]!);
  const names = pkg.archive.names().filter((name) => SLIDE_NAME.test(name)).sort((a, b) => number(a) - number(b));
  const presentation = pkg.has("ppt/presentation.xml") ? pkg.xml("ppt/presentation.xml") : null;
  const slideSize = presentation ? find(presentation, "p:sldSz", NS) : null;
  let slideLayout: Row = {};
  if (slideSize) {
    try { slideLayout = { width: Math.min(100_000_000, integer(slideSize.attrib.cx)), height: Math.min(100_000_000, integer(slideSize.attrib.cy)), unit: "emu" }; }
    catch { slideLayout = {}; }
  }
  names.slice(0, 100).forEach((name, offset) => {
    const slide = pkg.xml(name);
    const relsName = `${dirname(name) ? dirname(name) + "/" : ""}_rels/${name.slice(name.lastIndexOf("/") + 1)}.rels`;
    const relationships = pkg.relationships(relsName, name);
    const shapes = find(slide, "p:cSld/p:spTree", NS);
    const blocks: Row[] = [];
    if (shapes) {
      if (shapes.children.length > 200) truncated = true;
      for (const shape of shapes.children.slice(0, 200)) {
        const kind = shape.tag.slice(shape.tag.lastIndexOf("}") + 1);
        if (kind !== "sp" && kind !== "pic") continue;
        const xfrm = find(shape, ".//a:xfrm", NS);
        let position: Row = {};
        if (xfrm) {
          const off = find(xfrm, "a:off", NS), ext = find(xfrm, "a:ext", NS);
          try {
            if (off && ext) position = { x: Math.max(0, integer(off.attrib.x)), y: Math.max(0, integer(off.attrib.y)), width: Math.max(0, integer(ext.attrib.cx)), height: Math.max(0, integer(ext.attrib.cy)) };
          } catch { position = {}; }
        }
        const fill = find(shape, ".//a:solidFill/a:srgbClr", NS);
        const style: Row = fill && HEX6.test(fill.attrib.val ?? "") ? { fill: "#" + fill.attrib.val } : {};
        const runs = drawingRuns(shape, truncation);
        const text = boundedText(runs.map((run) => run.text).join(""), truncation) || boundedText(joinedText(shape, ".//a:t", NS), truncation);
        let image: Row | null = null;
        if (kind === "pic") {
          const blip = find(shape, ".//a:blip", NS);
          image = pkg.image(blip ? relationships[blip.attrib[R_EMBED] ?? ""] : undefined, budget);
        }
        if (text || image) blocks.push({ type: image ? "image" : "shape", text, runs, position, style, images: image ? [image] : [] });
      }
    } else {
      const paragraphs = findall(slide, ".//a:p", NS);
      if (paragraphs.length > 200) truncated = true;
      for (const paragraph of paragraphs.slice(0, 200)) {
        const runs = drawingRuns(paragraph, truncation);
        blocks.push({ type: "text", text: boundedText(runs.map((run) => run.text).join(""), truncation), runs, style: {}, position: {}, images: [] });
      }
    }
    sections.push({ name: `Slide ${offset + 1}`, blocks, layout: slideLayout });
  });
  truncated ||= names.length > 100;
  return { sections, truncated };
}
