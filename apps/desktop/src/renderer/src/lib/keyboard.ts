/** Whether a key event comes from a text field (plain-key canvas shortcuts leave it alone). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as { isContentEditable?: boolean; tagName?: string } | null
  return (
    !!element &&
    (element.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName ?? ''))
  )
}
