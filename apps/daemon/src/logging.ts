import type { LogFn } from '@milibot/shared'
import { type Logger, type LoggerOptions, pino } from 'pino'

/** One JSON line per record on stdout (the daemon's log file collects the supervisor's and the runtimes'). */
export function createLogger(level: string, options: Omit<LoggerOptions, 'level'> = {}): Logger {
  return pino({ ...options, level })
}

/** The `LogFn` services take, writing through a pino logger. */
export function logFn(logger: Pick<Logger, 'info' | 'warn' | 'error'>): LogFn {
  return (level, message, extra) => logger[level](extra ?? {}, message)
}
