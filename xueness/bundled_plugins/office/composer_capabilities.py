"""Bounded authoring workflows backed by office read/create/replace tools."""
_COMMON = "Use office_read to review an existing workspace document before editing. Use office_create for a new file, or office_replace with expected_sha256 from the successful read for a complete structured replacement. A truncated or image-containing office_read does not grant a replacement proof: create a separate output file instead of replacing unseen content. Replacement rebuilds the document; it does not preserve unsupported rich layouts, animations, charts or embedded objects. Explain that limitation before replacing such content. Use explicit workspace-relative paths, reread the result and verify required content. Never claim completion from a tool call alone. Respect approvals and report errors instead of fabricating a file. "
CAPABILITIES = tuple({
    "id": "office." + fmt + "_authoring", "name": name, "nameEn": name_en,
    "description": description, "descriptionEn": description_en,
    "tools": ["office_read", "office_create", "office_replace"],
    "instructions": _COMMON + instructions,
} for fmt, name, name_en, description, description_en, instructions in (
    ("pdf", "PDF", "PDF", "创建、读取与重新排版 PDF 文档。", "Create, read and rebuild PDF documents.", "Format pdf, .pdf path. document={title?, paragraphs:[{text,style?:title|heading|body}]}. Read returns bounded page text; arbitrary PDF layout is not editable in place."),
    ("pptx", "演示文档", "Presentations", "创建、编辑与审阅 PPTX 幻灯片。", "Create, edit and review PPTX slides.", "Format pptx, .pptx path. document={title?,slides:[{title?,paragraphs?:[string],bullets?:[string]}]}. Use short titles (at most 60 characters), at most 20 text items per slide, at most 400 characters per item and 18 estimated display lines per slide. Build a coherent slide narrative and verify each slide."),
    ("xlsx", "电子表格", "Spreadsheets", "创建、编辑与审阅 XLSX 工作表。", "Create, edit and review XLSX sheets.", "Format xlsx, .xlsx path. document={sheets:[{name,rows:[[string|number|boolean|null]]}]}. Strings, including leading =, are literal text, not executable formulas; use computed numeric values and verify totals."),
    ("docx", "Word 文档", "Word documents", "创建、编辑与审阅 DOCX 文档。", "Create, edit and review DOCX documents.", "Format docx, .docx path. document={title?,paragraphs:[{text,style?,bold?,italic?}],tables?:[{rows:[[string]]}]}. Structure headings, paragraphs and tables; reread all required sections."),
))
