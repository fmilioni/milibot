/** NDJSON events of the guest agent's `GET /procs/:id/events`. */
export type GuestProcEvent =
  | { seq: number; type: 'stdout' | 'stderr'; data: string; partial?: boolean }
  | { seq: number; type: 'exit'; code: number | null; signal: string | null }
  | { seq: number; type: 'error'; message: string }
  | { type: 'heartbeat' }

export interface GuestProcSpec {
  user: string
  argv: string[]
  cwd: string
  env: Record<string, string>
  display: number
  label: string
  /** Slug of the bot the process works for (it runs in that bot's resource slice). */
  bot?: string
}

/**
 * What a CLI engine (Claude Code, Codex) needs from the daemon: processes in the VM, MCP endpoint, session ids.
 * The daemon gives each engine its own instance (session ids and MCP tokens are per engine).
 */
export interface GuestCliBackend {
  startProcess(spec: GuestProcSpec): Promise<{ id: string }>
  events(procId: string, since: number, signal: AbortSignal): AsyncIterable<GuestProcEvent>
  writeStdin(procId: string, data: string, eof?: boolean): Promise<void>
  signal(procId: string, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<void>
  /** Writes a private (0600) file owned by the `agent` user, returns its absolute path. */
  writeAgentFile(name: string, content: string): Promise<string>
  /**
   * URL (as seen from the guest) and bearer token of the daemon's MCP server for this bot; the token
   * also identifies the lane (`laneKey`, the bot id for its chat lane) so tool calls reach its turn.
   */
  mcpEndpoint(botId: string, laneKey: string): Promise<{ url: string; token: string }>
  /** The engine's session (Claude Code) or thread (Codex) id of a bot lane (`laneKey` = bot id for the chat lane). */
  getSessionId(laneKey: string): string | null
  setSessionId(laneKey: string, sessionId: string | null): void
}
