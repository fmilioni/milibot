import { type CliEngine, cliSettingKeys } from '@milibot/shared'

/**
 * Settings keys a CLI engine keeps its state under (`<engine>.<part>.<laneKey>`). Stored data depends on
 * these exact strings: never change them.
 */
export function cliKeys(engine: CliEngine) {
  const laneKey = (part: string) => (lane: string) => `${engine}.${part}.${lane}`
  const session = laneKey('session')
  const meta = laneKey('meta')
  const bootstrap = laneKey('bootstrap')
  return {
    /** The engine's session (Claude Code) or thread (Codex) id of a lane. */
    session,
    /** What Milibot knows about the lane's stored session (`CliSessionMeta`). */
    meta,
    /** Memory bootstrap the lane's session started with, resent identically on resume. */
    bootstrap,
    /** Every key of one lane (`'%'` gives the SQL `LIKE` patterns of all lanes). */
    lane: (lane: string) => [session(lane), meta(lane), bootstrap(lane)],
    rotateIdleMinutes: cliSettingKeys(engine).rotateIdleMinutes,
    rotateContextTokens: cliSettingKeys(engine).rotateContextTokens,
  }
}
