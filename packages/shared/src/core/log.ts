export type LogLevel = 'info' | 'warn' | 'error'

export type LogFn = (level: LogLevel, message: string, extra?: Record<string, unknown>) => void
