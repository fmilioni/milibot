import { crc32 } from 'node:zlib'

/** Minimal stored (uncompressed) ZIP, enough for OOXML/ODF fixtures. Entries are written in the given order. */
export function makeZip(entries: Array<[string, string]>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const centralDir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralDir, end])
}

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const SML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const PML = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const DML = 'http://schemas.openxmlformats.org/drawingml/2006/main'

const core = (title: string) =>
  `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`

export function xlsxFixture(): Buffer {
  return makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['docProps/core.xml', core('Sales 2025')],
    [
      'xl/workbook.xml',
      `<workbook xmlns="${SML}" xmlns:r="${REL}"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
    ],
    [
      'xl/sharedStrings.xml',
      `<sst xmlns="${SML}"><si><t>Customer</t></si><si><t>Total</t></si><si><r><t>Ana </t></r><r><t>Souza</t></r></si></sst>`,
    ],
    [
      'xl/styles.xml',
      `<styleSheet xmlns="${SML}"><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
    ],
    [
      'xl/worksheets/sheet1.xml',
      `<worksheet xmlns="${SML}"><sheetData>` +
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Date</t></is></c></row>` +
        `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1234.5</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" s="1"><v>45658</v></c></row>` +
        `<row r="4"><c r="B4"><v>10</v></c></row>` +
        `</sheetData></worksheet>`,
    ],
    [
      'xl/worksheets/sheet2.xml',
      `<worksheet xmlns="${SML}"><sheetData><row r="1"><c r="A1" t="str"><v>tab\there</v></c></row></sheetData></worksheet>`,
    ],
  ])
}

export function pptxFixture(): Buffer {
  const sp = (type: string | null, paragraphs: string[]) =>
    `<p:sp><p:nvSpPr><p:nvPr>${type ? `<p:ph type="${type}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody>${paragraphs
      .map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`)
      .join('')}</p:txBody></p:sp>`
  const slide = (body: string) =>
    `<p:sld xmlns:p="${PML}" xmlns:a="${DML}" xmlns:r="${REL}"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`
  const table =
    `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>` +
    `<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Month</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></a:txBody></a:tc></a:tr>` +
    `<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Jan</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>10</a:t></a:r></a:p></a:txBody></a:tc></a:tr>` +
    `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  return makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['docProps/core.xml', core('Plan')],
    [
      'ppt/presentation.xml',
      `<p:presentation xmlns:p="${PML}" xmlns:r="${REL}"><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    ],
    [
      'ppt/_rels/presentation.xml.rels',
      `<Relationships xmlns="${PKG_REL}"><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide2.xml"/><Relationship Id="rId3" Type="${REL}/slide" Target="slides/slide1.xml"/></Relationships>`,
    ],
    [
      'ppt/slides/slide1.xml',
      slide(sp('ctrTitle', ['Plan 2026']) + sp(null, ['First point', 'Second point'])),
    ],
    [
      'ppt/slides/_rels/slide1.xml.rels',
      `<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
    ],
    [
      'ppt/notesSlides/notesSlide1.xml',
      `<p:notes xmlns:p="${PML}" xmlns:a="${DML}"><p:cSld><p:spTree>${sp('sldImg', [])}${sp('body', ['Speak slowly'])}</p:spTree></p:cSld></p:notes>`,
    ],
    ['ppt/slides/slide2.xml', slide(sp('title', ['Figures']) + table)],
  ])
}

export function docxFixture(): Buffer {
  return makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['_rels/.rels', '<Relationships/>'],
    [
      'word/document.xml',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
    ],
  ])
}

export function odfFixture(mime: string): Buffer {
  return makeZip([
    ['mimetype', mime],
    ['META-INF/manifest.xml', '<manifest/>'],
    ['content.xml', '<office:document-content/>'],
  ])
}
