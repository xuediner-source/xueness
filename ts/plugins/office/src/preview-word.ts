/** DOCX part of Python `office_preview.preview_bytes`. */
import { pyInt } from "@xueness/contracts";
import { find, findall, joinedText, type XmlElement } from "./xml.ts";
import { boundedText, HEX6, isDigits, NS, R_EMBED, W_VAL, type ImageBudget, type Package, type Row, type Truncation } from "./preview-common.ts";

function wordRuns(element: XmlElement, truncation: Truncation): Row[] {
  const runs: Row[] = [];
  for (const run of findall(element, ".//w:r", NS)) {
    const text = joinedText(run, ".//w:t", NS);
    if (!text) continue;
    const props = find(run, "w:rPr", NS), style: Row = {};
    if (props) {
      for (const [tag, name] of [["b", "bold"], ["i", "italic"], ["strike", "strike"]] as const) if (find(props, "w:" + tag, NS)) style[name] = true;
      if (find(props, "w:u", NS)) style.underline = true;
      const color = find(props, "w:color", NS), size = find(props, "w:sz", NS);
      if (color && HEX6.test(color.attrib[W_VAL] ?? "")) style.color = "#" + color.attrib[W_VAL];
      if (size && isDigits(size.attrib[W_VAL])) style.fontSize = Math.min(48, Math.max(6, pyInt(size.attrib[W_VAL]!) / 2));
    }
    runs.push({ text: boundedText(text, truncation), style });
  }
  return runs;
}

export function previewWord(pkg: Package, truncation: Truncation, budget: ImageBudget): { sections: Row[]; truncated: boolean } {
  let truncated = false;
  const document = pkg.xml("word/document.xml");
  const body = find(document, "w:body", NS);
  const relationships = pkg.relationships("word/_rels/document.xml.rels", "word/document.xml");
  const blocks: Row[] = [];
  if (body) {
    for (const child of body.children.slice(0, 500)) {
      if (child.tag.endsWith("}tbl")) {
        const tableRows = findall(child, "w:tr", NS);
        if (tableRows.length > 200) truncated = true;
        const rows = tableRows.slice(0, 200).map((row) => {
          const cells = findall(row, "w:tc", NS);
          if (cells.length > 50) truncated = true;
          return cells.slice(0, 50).map((cell) => boundedText(joinedText(cell, ".//w:t", NS), truncation));
        });
        blocks.push({ type: "table", table: rows });
        continue;
      }
      const runs = wordRuns(child, truncation);
      const paragraphProps = find(child, "w:pPr", NS), style: Row = {};
      if (paragraphProps) {
        const pstyle = find(paragraphProps, "w:pStyle", NS), align = find(paragraphProps, "w:jc", NS);
        if (pstyle) style.paragraphStyle = boundedText(pstyle.attrib[W_VAL] ?? "", truncation, 40);
        const value = align?.attrib[W_VAL];
        if (value && ["left", "center", "right", "both"].includes(value)) style.align = value === "both" ? "justify" : value;
      }
      const images: Row[] = [];
      for (const blip of findall(child, ".//a:blip", NS)) {
        const image = pkg.image(relationships[blip.attrib[R_EMBED] ?? ""], budget);
        if (image) images.push(image);
      }
      const text = boundedText(runs.map((run) => run.text).join(""), truncation) || boundedText(joinedText(child, ".//w:t", NS), truncation);
      blocks.push({ type: "paragraph", text, runs, style, images });
    }
    truncated ||= body.children.length > 500;
  }
  const pageSize = find(document, ".//w:sectPr/w:pgSz", NS);
  let layout: Row = {};
  if (pageSize) {
    const width = pageSize.attrib[`{${NS.w}}w`], height = pageSize.attrib[`{${NS.w}}h`];
    if (isDigits(width) && isDigits(height)) layout = { width: Math.min(20000, pyInt(width)), height: Math.min(30000, pyInt(height)), unit: "twip" };
  }
  return { sections: [{ name: "Document", blocks, layout }], truncated };
}
