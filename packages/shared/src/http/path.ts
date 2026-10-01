type Segments<P extends string> = P extends `${infer Head}/${infer Tail}`
  ? Segments<Head> | Segments<Tail>
  : P extends `:${infer Param}`
    ? Param
    : never

export type PathParams<P extends string> = { [K in Segments<P>]: string }

export function buildPath(path: string, params: Record<string, string>): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name]
    if (value === undefined) throw new Error(`Missing path param: ${name}`)
    return encodeURIComponent(value)
  })
}
