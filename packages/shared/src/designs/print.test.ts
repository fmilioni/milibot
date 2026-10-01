import { describe, expect, it } from 'vitest'

import { escapeAttribute, printDocument } from './print'

const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'">`
const STYLE =
  '<style>html,body{margin:0;padding:0}section{display:block;overflow:hidden;break-after:page;break-inside:avoid}' +
  'section:last-child{break-after:auto}iframe{border:0;display:block}'

describe('printDocument', () => {
  it('builds the daemon print page (iframes by URL, CSP, measured heights)', () => {
    const frames = [
      { id: 'f1', width: 400, height: 300, measuredHeight: null },
      { id: 'f2', width: 800, height: null, measuredHeight: 1234 },
      { id: 'f3', width: 200, height: null, measuredHeight: null },
    ]
    expect(printDocument(frames, (f) => `src="/render/tok/${f.id}?theme=dark%20mode"`, CSP)).toBe(
      [
        '<!doctype html>',
        '<html><head><meta charset="utf-8">',
        CSP,
        `${STYLE}\nsection.p0 { page: p0 }\nsection.p1 { page: p1 }\nsection.p2 { page: p2 }</style>`,
        '</head><body>' +
          '<section class="p0" style="width:400px;height:300px"><iframe src="/render/tok/f1?theme=dark%20mode" data-width="400" data-height="300" width="400" height="300"></iframe></section>' +
          '<section class="p1" style="width:800px;height:1234px"><iframe src="/render/tok/f2?theme=dark%20mode" data-width="800" data-height="0" width="800" height="1234"></iframe></section>' +
          '<section class="p2" style="width:200px;height:1000px"><iframe src="/render/tok/f3?theme=dark%20mode" data-width="200" data-height="0" width="200" height="1000"></iframe></section>' +
          '</body></html>',
      ].join('\n'),
    )
  })

  it('builds the desktop export page (inline srcdoc)', () => {
    const frames = [
      { html: '<p class="x">"&"</p>', width: 400, height: 300 },
      { html: '<b>hi</b>', width: 500, height: null },
    ]
    expect(printDocument(frames, (f) => `srcdoc="${escapeAttribute(f.html)}"`)).toBe(
      [
        '<!doctype html>',
        '<html><head><meta charset="utf-8">',
        `${STYLE}\nsection.p0 { page: p0 }\nsection.p1 { page: p1 }</style>`,
        '</head><body>' +
          '<section class="p0" style="width:400px;height:300px"><iframe srcdoc="<p class=&quot;x&quot;>&quot;&amp;&quot;</p>" data-width="400" data-height="300" width="400" height="300"></iframe></section>' +
          '<section class="p1" style="width:500px;height:1000px"><iframe srcdoc="<b>hi</b>" data-width="500" data-height="0" width="500" height="1000"></iframe></section>' +
          '</body></html>',
      ].join('\n'),
    )
  })
})
