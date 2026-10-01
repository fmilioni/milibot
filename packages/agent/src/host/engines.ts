import type { Bot } from '@milibot/shared'

import type { CliResolvedModel, NativeResolvedModel, RunnableModel, TurnRequest } from '../environment'
import type { HostContext } from './context'
import type { TurnState } from './state'
import { CliTurns } from './turn/cli-turn'
import { NativeLoop } from './turn/native-loop'

/** A turn about to run on its resolved model. */
export interface TurnRun {
  bot: Bot
  request: TurnRequest
  turn: TurnState
}

/** Runs turns on one kind of model: the native step loop, or the CLI engines' processes. */
export interface TurnEngine<M extends RunnableModel> {
  run(run: TurnRun, resolved: M): Promise<void>
}

/** Every kind of model a turn can run on, and the engine that runs it. */
export class TurnEngines {
  private readonly native: TurnEngine<NativeResolvedModel>
  private readonly cli: TurnEngine<CliResolvedModel>

  constructor(ctx: HostContext) {
    this.native = new NativeLoop(ctx)
    this.cli = new CliTurns(ctx)
  }

  run(run: TurnRun, resolved: RunnableModel): Promise<void> {
    return resolved.kind === 'cli' ? this.cli.run(run, resolved) : this.native.run(run, resolved)
  }
}
