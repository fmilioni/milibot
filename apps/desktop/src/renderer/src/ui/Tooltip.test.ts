import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Tooltip } from './Tooltip'

describe('Tooltip', () => {
  it('renders the trigger as is, without wrappers or a title', () => {
    const button = createElement('button', { type: 'button', 'aria-label': 'Send' }, 'x')
    const html = renderToStaticMarkup(createElement(Tooltip, { content: 'Send', children: button }))
    expect(html).toBe('<button type="button" aria-label="Send">x</button>')
  })

  it('leaves the trigger untouched without content', () => {
    const span = createElement('span', { className: 'a' }, 'y')
    expect(renderToStaticMarkup(createElement(Tooltip, { content: null, children: span }))).toBe(
      '<span class="a">y</span>',
    )
  })
})
