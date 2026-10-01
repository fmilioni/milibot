/** Memory injected when a process starts (see `buildMemoryBootstrap`). */
export interface CliStartup {
  /** Appended to the engine's system prompt addition for this process (identical across resumes of a session). */
  systemAppendix: string
  /** Prepended to the first input of the process (memory updates for a resumed session). */
  inputPrefix: string | null
  sections: { longTermMemory: number; summaries: number; recap: number }
}

export const EMPTY_BOOTSTRAP_SECTIONS: CliStartup['sections'] = {
  longTermMemory: 0,
  summaries: 0,
  recap: 0,
}

/** Nothing injected (helpers: their task is their whole input). */
export function emptyStartup(): CliStartup {
  return { systemAppendix: '', inputPrefix: null, sections: EMPTY_BOOTSTRAP_SECTIONS }
}

/** The bootstrap a lane's CLI session started with, stored so every resume passes the byte-identical text. */
export interface CliBootstrap {
  appendix: string
  digest: string
  sections: CliStartup['sections']
}
