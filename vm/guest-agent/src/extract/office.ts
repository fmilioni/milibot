import type { ExtractedPage } from '@milibot/shared/portable/guest-api'

/**
 * Text of xlsx (one page per sheet, one row per line, cells separated by tabs) and pptx (one page per slide:
 * shapes in order, tables as tab-separated rows, speaker notes at the end). Python 3 stdlib only.
 * Usage: `python3 -I -c OFFICE_SCRIPT <xlsx|pptx> [file]` (stdin without a file); prints JSON
 * `{title, pages: [{n, title, text}], truncated}`.
 */
export const OFFICE_SCRIPT = String.raw`
import sys, io, json, zipfile, posixpath, re, datetime
import xml.etree.ElementTree as ET

MAX_PART = 256 * 1024 * 1024
MAX_CELLS = 2_000_000
NS = {
    'm': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'pr': 'http://schemas.openxmlformats.org/package/2006/relationships',
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'dc': 'http://purl.org/dc/elements/1.1/',
}
R_ID = '{%s}id' % NS['r']

def q(prefix, tag):
    return '{%s}%s' % (NS[prefix], tag)

def read(z, name):
    try:
        info = z.getinfo(name)
    except KeyError:
        return None
    if info.file_size > MAX_PART:
        raise ValueError('part too large: ' + name)
    with z.open(info) as f:
        return f.read(MAX_PART + 1)

def parse(z, name):
    data = read(z, name)
    return None if data is None else ET.fromstring(data)

def rels(z, part):
    folder, base = posixpath.split(part)
    root = parse(z, posixpath.join(folder, '_rels', base + '.rels'))
    out = {}
    if root is None:
        return out
    for rel in root.findall(q('pr', 'Relationship')):
        target = rel.get('Target', '')
        if rel.get('TargetMode') == 'External':
            continue
        path = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(folder, target))
        out[rel.get('Id')] = (path, rel.get('Type', ''))
    return out

def core_title(z):
    root = parse(z, 'docProps/core.xml')
    if root is None:
        return None
    el = root.find(q('dc', 'title'))
    text = (el.text or '').strip() if el is not None else ''
    return text or None

def col_index(ref):
    n = 0
    for ch in ref:
        if 'A' <= ch <= 'Z':
            n = n * 26 + ord(ch) - 64
        elif 'a' <= ch <= 'z':
            n = n * 26 + ord(ch) - 96
        else:
            break
    return n - 1

DATE_IDS = set(range(14, 23)) | {45, 46, 47}

def is_date_format(code):
    code = re.sub(r'"[^"]*"|\\.|\[[^\]]*\]', '', code or '')
    return bool(re.search(r'[dmyhs]', code, re.I)) and not re.fullmatch(r'[#0.,%\s]*', code)

def date_styles(z):
    root = parse(z, 'xl/styles.xml')
    if root is None:
        return set()
    custom = {}
    fmts = root.find(q('m', 'numFmts'))
    if fmts is not None:
        for f in fmts.findall(q('m', 'numFmt')):
            custom[int(f.get('numFmtId', '0'))] = f.get('formatCode', '')
    out = set()
    xfs = root.find(q('m', 'cellXfs'))
    if xfs is not None:
        for i, xf in enumerate(xfs.findall(q('m', 'xf'))):
            fid = int(xf.get('numFmtId', '0'))
            if fid in DATE_IDS or (fid in custom and is_date_format(custom[fid])):
                out.add(i)
    return out

def serial_to_date(value, date1904):
    try:
        v = float(value)
    except ValueError:
        return value
    base = datetime.datetime(1904, 1, 1) if date1904 else datetime.datetime(1899, 12, 30)
    try:
        d = base + datetime.timedelta(days=v)
    except OverflowError:
        return value
    if abs(v - int(v)) < 1e-9:
        return d.strftime('%Y-%m-%d')
    if v < 1:
        return d.strftime('%H:%M:%S')
    return d.strftime('%Y-%m-%d %H:%M:%S')

def number(value):
    try:
        f = float(value)
    except ValueError:
        return value
    if f.is_integer() and abs(f) < 1e15:
        return str(int(f))
    return '%.15g' % f

def si_text(si):
    parts = []
    for child in si:
        if child.tag == q('m', 't'):
            parts.append(child.text or '')
        elif child.tag == q('m', 'r'):
            for t in child.iter(q('m', 't')):
                parts.append(t.text or '')
    return ''.join(parts)

def clean_cell(text):
    return re.sub(r'[\t\r\n]+', ' ', text).strip()

def xlsx(z):
    wb_part = 'xl/workbook.xml'
    wb = parse(z, wb_part)
    if wb is None:
        raise ValueError('not a spreadsheet: xl/workbook.xml is missing')
    pr = wb.find(q('m', 'workbookPr'))
    date1904 = pr is not None and pr.get('date1904') in ('1', 'true')
    wb_rels = rels(z, wb_part)
    shared = []
    sst = parse(z, 'xl/sharedStrings.xml')
    if sst is not None:
        shared = [si_text(si) for si in sst.findall(q('m', 'si'))]
    dates = date_styles(z)
    pages = []
    cells = 0
    truncated = False
    sheets = wb.find(q('m', 'sheets'))
    for n, sheet in enumerate(sheets.findall(q('m', 'sheet')) if sheets is not None else [], start=1):
        name = sheet.get('name', 'Sheet %d' % n)
        target = wb_rels.get(sheet.get(R_ID))
        rows = []
        if target and not truncated:
            data = read(z, target[0])
            if data is not None:
                for _, row in ET.iterparse(io.BytesIO(data)):
                    if row.tag != q('m', 'row'):
                        continue
                    values = {}
                    for c in row.findall(q('m', 'c')):
                        t = c.get('t', 'n')
                        v = c.find(q('m', 'v'))
                        raw = v.text if v is not None and v.text is not None else ''
                        if t == 's':
                            try:
                                text = shared[int(raw)]
                            except (ValueError, IndexError):
                                text = raw
                        elif t == 'inlineStr':
                            is_ = c.find(q('m', 'is'))
                            text = si_text(is_) if is_ is not None else ''
                        elif t == 'b':
                            text = 'TRUE' if raw == '1' else 'FALSE'
                        elif t in ('str', 'e', 'd'):
                            text = raw
                        elif raw and int(c.get('s', '0') or 0) in dates:
                            text = serial_to_date(raw, date1904)
                        else:
                            text = number(raw) if raw else ''
                        text = clean_cell(text)
                        if text:
                            ref = c.get('r')
                            idx = col_index(ref) if ref else (max(values) + 1 if values else 0)
                            values[idx] = text
                    row.clear()
                    if values:
                        cells += len(values)
                        rows.append('\t'.join(values.get(i, '') for i in range(max(values) + 1)))
                    if cells > MAX_CELLS:
                        truncated = True
                        break
        pages.append({'n': n, 'title': name, 'text': '\n'.join(rows)})
    return {'title': core_title(z), 'pages': pages, 'truncated': truncated}

def paragraph_text(p):
    parts = []
    for el in p.iter():
        if el.tag == q('a', 't'):
            parts.append(el.text or '')
        elif el.tag == q('a', 'br'):
            parts.append('\n')
    return ''.join(parts)

def shape_lines(el, out):
    if el.tag == q('a', 'tbl'):
        for tr in el.findall(q('a', 'tr')):
            cells = []
            for tc in tr.findall(q('a', 'tc')):
                cells.append(clean_cell(' '.join(paragraph_text(p) for p in tc.iter(q('a', 'p')))))
            if any(cells):
                out.append('\t'.join(cells))
        return
    if el.tag == q('a', 'p'):
        text = paragraph_text(el).strip()
        if text:
            out.append(text)
        return
    for child in el:
        shape_lines(child, out)

def slide_title(root):
    for sp in root.iter(q('p', 'sp')):
        ph = sp.find('.//' + q('p', 'ph'))
        if ph is not None and ph.get('type') in ('title', 'ctrTitle'):
            lines = []
            shape_lines(sp, lines)
            text = ' '.join(lines).strip()
            if text:
                return text
    return None

def pptx(z):
    pres_part = 'ppt/presentation.xml'
    pres = parse(z, pres_part)
    if pres is None:
        raise ValueError('not a presentation: ppt/presentation.xml is missing')
    pres_rels = rels(z, pres_part)
    pages = []
    ids = pres.find(q('p', 'sldIdLst'))
    for n, sld in enumerate(ids.findall(q('p', 'sldId')) if ids is not None else [], start=1):
        target = pres_rels.get(sld.get(R_ID))
        root = parse(z, target[0]) if target else None
        if root is None:
            pages.append({'n': n, 'title': None, 'text': ''})
            continue
        lines = []
        tree = root.find(q('p', 'cSld'))
        shape_lines(tree if tree is not None else root, lines)
        for path, kind in rels(z, target[0]).values():
            if kind.endswith('/notesSlide'):
                notes = parse(z, path)
                if notes is None:
                    continue
                note_lines = []
                for sp in notes.iter(q('p', 'sp')):
                    ph = sp.find('.//' + q('p', 'ph'))
                    if ph is not None and ph.get('type') == 'body':
                        shape_lines(sp, note_lines)
                if note_lines:
                    lines.append('')
                    lines.append('Notes:')
                    lines.extend(note_lines)
        pages.append({'n': n, 'title': slide_title(root), 'text': '\n'.join(lines)})
    return {'title': core_title(z), 'pages': pages, 'truncated': False}

def main():
    kind = sys.argv[1]
    data = open(sys.argv[2], 'rb').read() if len(sys.argv) > 2 else sys.stdin.buffer.read()
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        result = xlsx(z) if kind == 'xlsx' else pptx(z)
    except (zipfile.BadZipFile, ET.ParseError, ValueError, KeyError) as e:
        sys.stderr.write('%s: %s\n' % (type(e).__name__, e))
        sys.exit(3)
    json.dump(result, sys.stdout, ensure_ascii=False)

main()
`

export interface OfficeOutput {
  title?: string
  pages: ExtractedPage[]
  truncated: boolean
}

export function parseOfficeOutput(stdout: string): OfficeOutput {
  const parsed = JSON.parse(stdout) as {
    title?: string | null
    pages?: Array<{ n: number; title?: string | null; text: string }>
    truncated?: boolean
  }
  return {
    ...(parsed.title ? { title: parsed.title } : {}),
    pages: (parsed.pages ?? []).map((p) => ({
      n: p.n,
      text: p.text,
      ocr: false,
      ...(p.title ? { title: p.title } : {}),
    })),
    truncated: parsed.truncated === true,
  }
}
