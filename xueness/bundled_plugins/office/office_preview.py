"""Read-only Office Open XML preview; no macros, links or formulas execute."""
import io
import base64
import posixpath
from pathlib import Path, PurePosixPath
import re
import urllib.parse
import zipfile
import xml.etree.ElementTree as ET

MAX_BYTES = 8_000_000
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      's': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
      'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}

IMAGE_MIMES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
               '.gif': 'image/gif', '.webp': 'image/webp'}
MAX_IMAGE_COUNT = 16
MAX_IMAGE_BYTES = 256_000
MAX_IMAGE_TOTAL = 1_000_000
MAX_FULL_DOCUMENT_BYTES = MAX_BYTES
MAX_FULL_DOCUMENT_ENTRIES = 1200
MAX_FULL_DOCUMENT_UNCOMPRESSED = 32_000_000
MAX_FULL_DOCUMENT_XML = 4_000_000
FULL_DOCUMENT_IMAGE_COUNT = 16
FULL_DOCUMENT_IMAGE_BYTES = 1_000_000
_BLOCKED_PART_WORDS = ('vbaproject', 'activex', 'embeddings/', 'oleobject', 'customui/',
                       'customxml/', 'webextensions/', 'connections.xml', 'querytables/')
_BLOCKED_ELEMENTS = {'altchunk', 'object', 'oleobject', 'control', 'webextension',
                     'externalreference', 'instrtext', 'fldsimple', 'hlinkclick', 'hlinkhover'}


def _full_document_part_name(name):
    name = name.replace('\\', '/')
    path = PurePosixPath(name)
    return (name and not name.startswith('/') and not path.is_absolute()
            and all(part not in ('', '.', '..') for part in path.parts)
            and not name.startswith('../'))


def _blocked_part(name):
    lowered = name.lower()
    return (any(word in lowered for word in _BLOCKED_PART_WORDS)
            or lowered.endswith(('.bin', '.html', '.htm', '.mht', '.fntdata', '.svg')))


def _relationship_owner(name):
    # `word/_rels/document.xml.rels` belongs to `word/document.xml`.
    parent, basename = posixpath.split(name)
    if posixpath.basename(parent) != '_rels' or not basename.endswith('.rels'):
        return None
    owner = basename[:-5]
    return posixpath.join(posixpath.dirname(parent), owner)


def _strip_unsafe_xml(root):
    for parent in list(root.iter()):
        for child in list(parent):
            local = child.tag.rsplit('}', 1)[-1].lower() if isinstance(child.tag, str) else ''
            if local in _BLOCKED_ELEMENTS:
                parent.remove(child)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def sanitize_full_document(data, suffix):
    """Build a conservative OOXML subset safe for the optional browser renderers.

    This is deliberately separate from the compact DTO parser: packages that do
    not satisfy these stricter checks still receive the static read-only preview.
    No original ZIP bytes are returned to the browser.
    """
    if suffix not in ('.docx', '.pptx') or len(data) > MAX_FULL_DOCUMENT_BYTES:
        return None
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as source:
            infos = source.infolist()
            if len(infos) > MAX_FULL_DOCUMENT_ENTRIES:
                return None
            source_files = {}
            source_size = 0
            for info in infos:
                name = info.filename.replace('\\', '/')
                if info.is_dir():
                    continue
                if not _full_document_part_name(name) or name in source_files or info.flag_bits & 1:
                    return None
                source_size += info.file_size
                if source_size > MAX_FULL_DOCUMENT_UNCOMPRESSED:
                    return None
                source_files[name] = info

            sanitized = {}
            image_count = image_bytes = 0
            for name, info in source_files.items():
                lower = name.lower()
                if _blocked_part(name):
                    continue
                if lower.endswith(('.xml', '.rels')) or name == '[Content_Types].xml':
                    if info.file_size > MAX_FULL_DOCUMENT_XML:
                        return None
                    raw = source.read(info)
                    root = ET.fromstring(_xml_bytes(raw))
                    if name.endswith('.rels'):
                        owner = _relationship_owner(name)
                        base = posixpath.dirname(owner or '')
                        for relation in list(root):
                            target = relation.attrib.get('Target', '')
                            parsed = urllib.parse.urlsplit(target)
                            if (not target or relation.attrib.get('TargetMode', '').lower() == 'external'
                                    or parsed.scheme or parsed.netloc or target.startswith('//')):
                                root.remove(relation)
                                continue
                            resolved = (target.lstrip('/') if target.startswith('/')
                                        else posixpath.normpath(posixpath.join(base, target.replace('\\', '/'))))
                            if (not _full_document_part_name(resolved) or resolved not in source_files
                                    or _blocked_part(resolved)):
                                root.remove(relation)
                                continue
                            relation_type = relation.attrib.get('Type', '').lower()
                            if any(word in relation_type for word in ('oleobject', 'activex', 'vbaproject', 'package', 'font')):
                                root.remove(relation)
                    elif name == '[Content_Types].xml':
                        for item in list(root):
                            local = item.tag.rsplit('}', 1)[-1].lower()
                            if local == 'override':
                                part = item.attrib.get('PartName', '').lstrip('/')
                                content_type = item.attrib.get('ContentType', '').lower()
                                if (part not in source_files or _blocked_part(part)
                                        or any(word in content_type for word in ('macroenabled', 'vbaproject', 'activex', 'oleobject'))):
                                    root.remove(item)
                            elif local == 'default':
                                extension = item.attrib.get('Extension', '').lower()
                                content_type = item.attrib.get('ContentType', '').lower()
                                if extension in ('bin', 'html', 'htm', 'mht', 'fntdata', 'svg') or any(
                                    word in content_type for word in ('macroenabled', 'vbaproject', 'activex', 'oleobject')
                                ):
                                    root.remove(item)
                    sanitized[name] = _strip_unsafe_xml(root)
                elif lower.endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp')) and '/media/' in '/' + lower:
                    if image_count >= FULL_DOCUMENT_IMAGE_COUNT or info.file_size <= 0 or image_bytes + info.file_size > FULL_DOCUMENT_IMAGE_BYTES:
                        continue
                    raw = source.read(info)
                    suffix_image = Path(lower).suffix
                    signature = {'.png': b'\x89PNG\r\n\x1a\n', '.jpg': b'\xff\xd8\xff',
                                 '.jpeg': b'\xff\xd8\xff', '.gif': (b'GIF87a', b'GIF89a'), '.webp': b'RIFF'}[suffix_image]
                    valid = raw.startswith(signature) if isinstance(signature, bytes) else raw.startswith(signature)
                    if suffix_image == '.webp': valid = valid and raw[8:12] == b'WEBP'
                    if not valid:
                        continue
                    sanitized[name] = raw
                    image_count += 1
                    image_bytes += len(raw)
                # All other binary/package members are omitted, including fonts,
                # embedded HTML, OLE payloads, and executable attachments.

            # Relationship filtering is order-independent; discard references
            # to any parts omitted by the media and executable-payload policy.
            for name, raw in list(sanitized.items()):
                if not name.endswith('.rels'):
                    continue
                root = ET.fromstring(raw)
                owner = _relationship_owner(name)
                base = posixpath.dirname(owner or '')
                changed = False
                for relation in list(root):
                    target = relation.attrib.get('Target', '')
                    resolved = (target.lstrip('/') if target.startswith('/') else
                                posixpath.normpath(posixpath.join(base, target.replace('\\', '/'))))
                    if not target or not _full_document_part_name(resolved) or resolved not in sanitized:
                        root.remove(relation)
                        changed = True
                if changed:
                    sanitized[name] = _strip_unsafe_xml(root)

            required = ('[Content_Types].xml', '_rels/.rels',
                        'word/document.xml' if suffix == '.docx' else 'ppt/presentation.xml')
            if any(name not in sanitized for name in required):
                return None
            output = io.BytesIO()
            with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as target:
                for name, raw in sanitized.items():
                    target.writestr(name, raw)
            result = output.getvalue()
            return base64.b64encode(result).decode('ascii') if len(result) <= MAX_FULL_DOCUMENT_BYTES else None
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, ET.ParseError, RuntimeError):
        return None


def _xml_bytes(raw):
    markup = raw.replace(b'\x00', b'').upper()
    if b'<!DOCTYPE' in markup or b'<!ENTITY' in markup:
        raise ValueError('XML entities are not supported')
    return raw


def _relationship_targets(archive, rels_name, owner_name):
    """Read only internal, package-local relationships; never follow URLs."""
    if rels_name not in archive.namelist():
        return {}
    root = ET.fromstring(_xml_bytes(archive.read(rels_name)))
    base = posixpath.dirname(owner_name)
    result = {}
    for rel in root:
        rid, target = rel.attrib.get('Id'), rel.attrib.get('Target', '')
        if not rid or not target or rel.attrib.get('TargetMode') == 'External':
            continue
        target = target.replace('\\', '/')
        if target.startswith('/'):
            resolved = target.lstrip('/')
        else:
            resolved = posixpath.normpath(posixpath.join(base, target))
        if resolved.startswith('../') or resolved == '..' or PurePosixPath(resolved).is_absolute():
            continue
        result[rid] = resolved
    return result


def _image_data(archive, target, budget):
    if not target or len(budget['images']) >= MAX_IMAGE_COUNT:
        return None
    suffix = Path(target).suffix.lower()
    mime = IMAGE_MIMES.get(suffix)
    if not mime or target not in archive.namelist():
        return None
    info = archive.getinfo(target)
    if info.file_size <= 0 or info.file_size > MAX_IMAGE_BYTES or budget['bytes'] + info.file_size > MAX_IMAGE_TOTAL:
        budget['truncated'] = True
        return None
    data = archive.read(target)
    signatures = {'image/png': b'\x89PNG\r\n\x1a\n', 'image/jpeg': b'\xff\xd8\xff',
                  'image/gif': (b'GIF87a', b'GIF89a'), 'image/webp': b'RIFF'}
    signature = signatures[mime]
    if isinstance(signature, tuple):
        valid = data.startswith(signature)
    else:
        valid = data.startswith(signature) and (mime != 'image/webp' or data[8:12] == b'WEBP')
    if not valid:
        return None
    budget['bytes'] += len(data)
    record = {'mime': mime, 'dataUrl': f'data:{mime};base64,{base64.b64encode(data).decode("ascii")}',
              'alt': ''}
    budget['images'].append(record)
    return record


def _bounded_text(text, truncation, limit=8000):
    if len(text) > limit:
        truncation[0] = True
    return text[:limit]


def _word_runs(element, truncation):
    runs = []
    for run in element.findall('.//w:r', NS):
        text = ''.join(node.text or '' for node in run.findall('.//w:t', NS))
        if not text:
            continue
        props = run.find('w:rPr', NS)
        style = {}
        if props is not None:
            for tag, name in (('b', 'bold'), ('i', 'italic'), ('strike', 'strike')):
                if props.find('w:' + tag, NS) is not None:
                    style[name] = True
            if props.find('w:u', NS) is not None:
                style['underline'] = True
            color = props.find('w:color', NS)
            size = props.find('w:sz', NS)
            if color is not None and re.fullmatch(r'[0-9A-Fa-f]{6}', color.attrib.get('{' + NS['w'] + '}val', '')):
                style['color'] = '#' + color.attrib['{' + NS['w'] + '}val']
            if size is not None and size.attrib.get('{' + NS['w'] + '}val', '').isdigit():
                style['fontSize'] = min(48, max(6, int(size.attrib['{' + NS['w'] + '}val']) / 2))
        runs.append({'text': _bounded_text(text, truncation), 'style': style})
    return runs


def _a_runs(element, truncation):
    runs = []
    for run in element.findall('.//a:r', NS):
        text = ''.join(node.text or '' for node in run.findall('.//a:t', NS))
        if not text:
            continue
        props = run.find('a:rPr', NS)
        style = {}
        if props is not None:
            if props.attrib.get('b') == '1': style['bold'] = True
            if props.attrib.get('i') == '1': style['italic'] = True
            if props.attrib.get('u') not in (None, 'none'): style['underline'] = True
            size = props.attrib.get('sz')
            if size and size.isdigit(): style['fontSize'] = min(48, max(6, int(size) / 100))
            color = props.find('a:solidFill/a:srgbClr', NS)
            if color is not None and re.fullmatch(r'[0-9A-Fa-f]{6}', color.attrib.get('val', '')):
                style['color'] = '#' + color.attrib['val']
        runs.append({'text': _bounded_text(text, truncation), 'style': style})
    return runs


def preview(path):
    with Path(path).open('rb') as stream:
        data = stream.read(MAX_BYTES+1)
    return preview_bytes(data, Path(path).suffix.lower())


def preview_bytes(data, suffix, *, include_full_document=True):
    """Return the bounded, read-only preview for one in-memory package.

    ``office_read`` uses this entrypoint after opening a workspace file once,
    so the digest it records describes the same bytes that the parser sees.
    """
    if len(data) > MAX_BYTES:
        raise ValueError('Office file too large')
    suffix = suffix.lower()
    full_document = sanitize_full_document(data, suffix) if include_full_document else None
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 2000 or sum(e.file_size for e in entries) > 40_000_000:
            raise ValueError('Office archive exceeds preview budget')
        def xml(name):
            info = archive.getinfo(name)
            if info.file_size > 4_000_000:
                raise ValueError('Office XML exceeds preview budget')
            return ET.fromstring(_xml_bytes(archive.read(name)))
        truncation = [False]
        def texts(element, prefix):
            return _bounded_text(''.join(t.text or '' for t in element.findall('.//' + prefix + ':t', NS)),
                                 truncation)
        sections = []
        truncated = False
        image_budget = {'images': [], 'bytes': 0, 'truncated': False}
        if suffix == '.docx':
            document = xml('word/document.xml')
            body = document.find('w:body', NS)
            relationships = _relationship_targets(archive, 'word/_rels/document.xml.rels', 'word/document.xml')
            blocks = []
            if body is not None:
                for child in list(body)[:500]:
                    if child.tag.endswith('}tbl'):
                        table_rows = child.findall('w:tr', NS)
                        if len(table_rows) > 200:
                            truncated = True
                        rows = []
                        for row in table_rows[:200]:
                            cells = row.findall('w:tc', NS)
                            if len(cells) > 50:
                                truncated = True
                            rows.append([texts(cell, 'w') for cell in cells[:50]])
                        blocks.append({'type': 'table', 'table': rows})
                    else:
                        runs = _word_runs(child, truncation)
                        paragraph_props = child.find('w:pPr', NS)
                        style = {}
                        if paragraph_props is not None:
                            pstyle = paragraph_props.find('w:pStyle', NS)
                            align = paragraph_props.find('w:jc', NS)
                            if pstyle is not None:
                                style['paragraphStyle'] = _bounded_text(
                                    pstyle.attrib.get('{' + NS['w'] + '}val', ''), truncation, 40)
                            if align is not None and align.attrib.get('{' + NS['w'] + '}val') in ('left', 'center', 'right', 'both'):
                                style['align'] = 'justify' if align.attrib.get('{' + NS['w'] + '}val') == 'both' else align.attrib.get('{' + NS['w'] + '}val')
                        images = []
                        for blip in child.findall('.//a:blip', NS):
                            rid = blip.attrib.get('{' + NS['r'] + '}embed')
                            image = _image_data(archive, relationships.get(rid), image_budget)
                            if image is not None: images.append(image)
                        text = _bounded_text(''.join(run['text'] for run in runs), truncation) or texts(child, 'w')
                        blocks.append({'type': 'paragraph', 'text': text, 'runs': runs, 'style': style, 'images': images})
                truncated |= len(body) > 500
            page_size = document.find('.//w:sectPr/w:pgSz', NS)
            layout = {}
            if page_size is not None:
                width, height = page_size.attrib.get('{' + NS['w'] + '}w'), page_size.attrib.get('{' + NS['w'] + '}h')
                if width and height and width.isdigit() and height.isdigit():
                    layout = {'width': min(20000, int(width)), 'height': min(30000, int(height)), 'unit': 'twip'}
            sections = [{'name': 'Document', 'blocks': blocks, 'layout': layout}]
        elif suffix == '.pptx':
            names = [n for n in archive.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)]
            names.sort(key=lambda n: int(re.search(r'slide(\d+)', n).group(1)))
            presentation = xml('ppt/presentation.xml') if 'ppt/presentation.xml' in archive.namelist() else None
            slide_size = presentation.find('p:sldSz', NS) if presentation is not None else None
            slide_layout = {}
            if slide_size is not None:
                try:
                    slide_layout = {'width': min(100_000_000, int(slide_size.attrib['cx'])),
                                    'height': min(100_000_000, int(slide_size.attrib['cy'])), 'unit': 'emu'}
                except (KeyError, ValueError):
                    slide_layout = {}
            for index, name in enumerate(names[:100], 1):
                slide = xml(name)
                rels_name = posixpath.join(posixpath.dirname(name), '_rels', posixpath.basename(name) + '.rels')
                relationships = _relationship_targets(archive, rels_name, name)
                shapes = slide.find('p:cSld/p:spTree', NS)
                blocks = []
                if shapes is not None:
                    shape_items = list(shapes)
                    if len(shape_items) > 200:
                        truncated = True
                    for shape in shape_items[:200]:
                        shape_kind = shape.tag.rsplit('}', 1)[-1]
                        if shape_kind not in ('sp', 'pic'):
                            continue
                        xfrm = shape.find('.//a:xfrm', NS)
                        position = {}
                        if xfrm is not None:
                            off, ext = xfrm.find('a:off', NS), xfrm.find('a:ext', NS)
                            try:
                                if off is not None and ext is not None:
                                    position = {'x': max(0, int(off.attrib['x'])), 'y': max(0, int(off.attrib['y'])),
                                                'width': max(0, int(ext.attrib['cx'])), 'height': max(0, int(ext.attrib['cy']))}
                            except (KeyError, ValueError):
                                position = {}
                        fill = shape.find('.//a:solidFill/a:srgbClr', NS)
                        style = {'fill': '#' + fill.attrib['val']} if fill is not None and re.fullmatch(r'[0-9A-Fa-f]{6}', fill.attrib.get('val', '')) else {}
                        runs = _a_runs(shape, truncation)
                        text = _bounded_text(''.join(run['text'] for run in runs), truncation) or texts(shape, 'a')
                        image = None
                        if shape_kind == 'pic':
                            blip = shape.find('.//a:blip', NS)
                            rid = blip.attrib.get('{' + NS['r'] + '}embed') if blip is not None else None
                            image = _image_data(archive, relationships.get(rid), image_budget)
                        if text or image:
                            blocks.append({'type': 'image' if image else 'shape', 'text': text, 'runs': runs,
                                           'position': position, 'style': style, 'images': [image] if image else []})
                else:
                    slide_paragraphs = slide.findall('.//a:p', NS)
                    if len(slide_paragraphs) > 200:
                        truncated = True
                    for paragraph in slide_paragraphs[:200]:
                        runs = _a_runs(paragraph, truncation)
                        text = _bounded_text(''.join(run['text'] for run in runs), truncation)
                        blocks.append({'type': 'text', 'text': text,
                                       'runs': runs, 'style': {}, 'position': {}, 'images': []})
                sections.append({'name': f'Slide {index}', 'blocks': blocks, 'layout': slide_layout})
            truncated |= len(names) > 100
        elif suffix == '.xlsx':
            shared = []
            if 'xl/sharedStrings.xml' in archive.namelist():
                shared = [texts(e, 's') for e in xml('xl/sharedStrings.xml').findall('s:si', NS)]
            relationships = _relationship_targets(archive, 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml')
            style_defs = []
            styles_name = 'xl/styles.xml'
            if styles_name in archive.namelist():
                style_root = xml(styles_name)
                fonts = style_root.findall('s:fonts/s:font', NS)
                fills = style_root.findall('s:fills/s:fill', NS)
                cell_xfs = style_root.findall('s:cellXfs/s:xf', NS)
                if len(cell_xfs) > 256:
                    truncated = True
                for xf in cell_xfs[:256]:
                    style = {}
                    try:
                        font = fonts[int(xf.attrib.get('fontId', '0'))]
                        if font.find('s:b', NS) is not None: style['bold'] = True
                        if font.find('s:i', NS) is not None: style['italic'] = True
                        color = font.find('s:color', NS)
                        rgb = color.attrib.get('rgb', '') if color is not None else ''
                        if re.fullmatch(r'[0-9A-Fa-f]{8}', rgb): style['color'] = '#' + rgb[-6:]
                        size = font.find('s:sz', NS)
                        if size is not None:
                            try: style['fontSize'] = min(48, max(6, float(size.attrib.get('val', '11'))))
                            except ValueError: pass
                    except (IndexError, ValueError):
                        pass
                    try:
                        fill = fills[int(xf.attrib.get('fillId', '0'))].find('s:patternFill/s:fgColor', NS)
                        rgb = fill.attrib.get('rgb', '') if fill is not None else ''
                        if re.fullmatch(r'[0-9A-Fa-f]{8}', rgb): style['background'] = '#' + rgb[-6:]
                    except (IndexError, ValueError):
                        pass
                    align = xf.find('s:alignment', NS)
                    if align is not None and align.attrib.get('horizontal') in ('left', 'center', 'right', 'justify'):
                        style['align'] = align.attrib['horizontal']
                    style_defs.append(style)
            sheets = xml('xl/workbook.xml').findall('s:sheets/s:sheet', NS)
            for sheet in sheets[:20]:
                target = relationships.get(sheet.attrib.get('{' + NS['r'] + '}id'), '')
                if not target:
                    continue
                name = target
                rows = []
                cell_styles = []
                all_rows = xml(name).findall('s:sheetData/s:row', NS)
                for row in all_rows[:200]:
                    cells = [''] * 50
                    row_styles = [{} for _ in range(50)]
                    for cell in row.findall('s:c', NS):
                        letters = re.match(r'[A-Z]+', cell.attrib.get('r', ''))
                        if not letters:
                            continue
                        index = 0
                        for char in letters[0]:
                            index = index * 26 + ord(char) - 64
                        if not 1 <= index <= 50:
                            truncated = True; continue
                        value = cell.find('s:v', NS)
                        text = value.text or '' if value is not None else texts(cell, 's')
                        if cell.attrib.get('t') == 's' and text.isdecimal():
                            text = shared[int(text)] if int(text) < len(shared) else ''
                        if not text and cell.find('s:f', NS) is not None:
                            text = '=' + (cell.find('s:f', NS).text or '')
                        cells[index-1] = _bounded_text(text, truncation)
                        try:
                            style_index = int(cell.attrib.get('s', '0'))
                            if 0 <= style_index < len(style_defs): row_styles[index-1] = style_defs[style_index]
                        except ValueError:
                            pass
                    while cells and not cells[-1]:
                        cells.pop()
                    row_styles = row_styles[:len(cells)]
                    rows.append(cells)
                    cell_styles.append(row_styles)
                truncated |= len(all_rows) > 200
                sheet_root = xml(name)
                columns = []
                column_items = sheet_root.findall('s:cols/s:col', NS)
                if len(column_items) > 50:
                    truncated = True
                for column in column_items[:50]:
                    try:
                        lo, hi, width = int(column.attrib.get('min', '0')), int(column.attrib.get('max', '0')), float(column.attrib.get('width', '0'))
                        if 1 <= lo <= hi <= 50 and 0 < width <= 100:
                            columns.append({'min': lo, 'max': hi, 'width': round(width, 2), 'hidden': column.attrib.get('hidden') == '1'})
                    except ValueError:
                        continue
                merge_items = sheet_root.findall('s:mergeCells/s:mergeCell', NS)
                if len(merge_items) > 200:
                    truncated = True
                merged = [item.attrib['ref'] for item in merge_items[:200]
                          if re.fullmatch(r'[A-Z]{1,3}\d+:[A-Z]{1,3}\d+', item.attrib.get('ref', ''))]
                sections.append({'name': sheet.attrib.get('name', 'Sheet'), 'blocks': [{'type': 'table', 'table': rows,
                                  'cellStyles': cell_styles, 'columns': columns, 'mergedRanges': merged}]})
            truncated |= len(sheets) > 20
        else:
            raise ValueError('unsupported Office format')
    truncated |= truncation[0]
    # Bound before serialization, including repeated shared-string cells.
    # Accounting per leaf avoids constructing a huge intermediate JSON string.
    remaining = 400000
    bounded = []
    for section in sections:
        if remaining <= 0:
            truncated = True; break
        if len(section['name']) > 200:
            truncated = True
        target = {'name': section['name'][:200], 'blocks': []}
        if section.get('layout'):
            target['layout'] = section['layout']
        remaining -= len(target['name']) + 100
        for block in section['blocks']:
            if remaining <= 0:
                truncated = True; break
            output = {key: block[key] for key in ('type', 'style', 'position') if key in block}
            if 'text' in block:
                text = block['text'][:max(0, remaining-100)]
                truncated |= len(text) < len(block['text'])
                remaining -= len(text) + 100
                output['text'] = text
            if 'runs' in block:
                runs = []
                if len(block['runs']) > 500:
                    truncated = True
                for run in block['runs'][:500]:
                    if remaining <= 0: truncated = True; break
                    text = run.get('text', '')[:max(0, remaining-20)]
                    truncated |= len(text) < len(run.get('text', ''))
                    remaining -= len(text) + 20
                    runs.append({'text': text, 'style': run.get('style', {})})
                output['runs'] = runs
            if 'table' in block:
                rows = []
                if len(block['table']) > 200 or any(len(row) > 50 for row in block['table'][:200]):
                    truncated = True
                for row in block['table'][:200]:
                    if remaining <= 0:
                        truncated = True; break
                    cells = []
                    for cell in row[:50]:
                        if remaining <= 0:
                            truncated = True; break
                        text = cell[:max(0, remaining-10)]
                        truncated |= len(text) < len(cell)
                        cells.append(text)
                        remaining -= len(text) + 10
                    rows.append(cells)
                truncated |= len(rows) < len(block['table'])
                output['table'] = rows
                if 'cellStyles' in block:
                    output['cellStyles'] = [row[:len(rows[i]) if i < len(rows) else 0] for i, row in enumerate(block['cellStyles'][:len(rows)])]
                if 'columns' in block: output['columns'] = block['columns'][:50]
                if 'mergedRanges' in block: output['mergedRanges'] = block['mergedRanges'][:200]
            if 'images' in block:
                if len(block['images']) > MAX_IMAGE_COUNT:
                    truncated = True
                output['images'] = block['images'][:MAX_IMAGE_COUNT]
            target['blocks'].append(output)
        bounded.append(target)
    truncated |= image_budget['truncated']
    result = {'kind': suffix[1:], 'sections': bounded, 'truncated': truncated,
              'imageCount': len(image_budget['images'])}
    if full_document is not None:
        result['fullDocument'] = full_document
    return result
