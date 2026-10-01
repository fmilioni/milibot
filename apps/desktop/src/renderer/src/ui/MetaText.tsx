import { Fragment } from 'react'

export const META_SEPARATOR = ' · '

/** Round dot between meta items; screen readers hear a comma. */
function MetaDot() {
  return (
    <span className="meta-dot">
      <span className="sr-only">, </span>
    </span>
  )
}

/** Renders "a · b · c" (or `parts`) with `MetaDot` separators instead of the thin middle dot. */
export function MetaText({ text, parts }: { text?: string; parts?: string[] }) {
  const items = (parts ?? text?.split(META_SEPARATOR) ?? []).filter(Boolean)
  return (
    <>
      {items.map((item, i) => (
        <Fragment key={i}>
          {i > 0 && <MetaDot />}
          {item}
        </Fragment>
      ))}
    </>
  )
}
