export const FETCH_TIMEOUT_MS = 20_000
export const FETCH_EXEC_TIMEOUT_MS = 25_000
/** After decompression; a larger body is cut and marked truncated. */
export const FETCH_MAX_BYTES = 5 * 1024 * 1024
export const FETCH_MAX_REDIRECTS = 5
export const FETCH_EXEC_MAX_OUTPUT = 10 * 1024 * 1024
/** Parsing runs on the runtime's event loop. */
export const HTML_PARSE_MAX_CHARS = 2_000_000

/** One part of a page (~10.5k characters): below the host's 12k cut of tool results. */
export const PAGE_TOKENS = 3_000
/** With a `prompt`, pages up to this size come back whole instead of through the helper model. */
export const SMALL_PAGE_TOKENS = 1_500
export const OUTLINE_MAX_CHARS = 400
export const EXTRACT_INPUT_MAX_CHARS = 60_000
export const EXTRACT_MAX_OUTPUT_TOKENS = 1_200
export const ANSWER_MAX_CHARS = 6_000
/** PDF pages read from one document. */
export const DOC_MAX_PAGES = 50

export const CACHE_TTL_MS = 15 * 60_000
export const CACHE_MAX_ENTRIES = 50
export const CACHE_MAX_CHARS = 20_000_000

export const SEARCH_DEFAULT_COUNT = 8
export const SNIPPET_MAX_CHARS = 200
export const TITLE_MAX_CHARS = 100
export const RESULT_URL_MAX_CHARS = 160
export const SEARCH_CACHE_TTL_MS = 15 * 60_000
export const PROVIDER_TIMEOUT_MS = 15_000
/** Page downloads at once through the guest agent (its port forward takes one connection at a time). */
export const MAX_CONCURRENT_VM_FETCHES = 2
