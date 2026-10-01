import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'

import { allowedChannels, type EventName, type InvokeName, type SendName } from '../../bridge/channels'
import {
  type EventArgs,
  events,
  type InvokeParsed,
  type InvokeResult,
  invokes,
  type SendParsed,
  sends,
} from '../../bridge/contract'
import { isAppWindow, windowKind } from '../windows/registry'
import { isTrustedSender, rendererLocation } from '../windows/trust'

export type InvokeHandler<K extends InvokeName> = (
  event: IpcMainInvokeEvent,
  args: InvokeParsed<K>,
) => InvokeResult<K> | Promise<InvokeResult<K>>

export type SendHandler<K extends SendName> = (event: IpcMainEvent, args: SendParsed<K>) => void

export type InvokeHandlers = { [K in InvokeName]: InvokeHandler<K> }
export type SendHandlers = { [K in SendName]: SendHandler<K> }

/**
 * Served only to the top frame of an app window on the app's own page, and only for channels its window
 * kind may use.
 */
function allowed(event: IpcMainEvent | IpcMainInvokeEvent, name: InvokeName | SendName): boolean {
  let frameUrl: string | null = null
  let topFrame = false
  try {
    const frame = event.senderFrame
    frameUrl = frame?.url ?? null
    topFrame = frame !== null && frame.parent === null
  } catch {
    // The frame was destroyed or navigated away while the message was in flight.
  }
  const sender = { webContentsId: event.sender.id, frameUrl, topFrame }
  if (!isTrustedSender(sender, rendererLocation(), isAppWindow)) return false
  const kind = windowKind(event.sender.id)
  return kind !== null && allowedChannels(kind).has(name)
}

/** An invoke channel: the page's arguments must match the contract before `fn` runs. */
export function handle<K extends InvokeName>(name: K, fn: InvokeHandler<K>): void {
  const { channel, args } = invokes[name]
  ipcMain.handle(channel, (event, ...raw: unknown[]) => {
    if (!allowed(event, name)) throw new Error(`Untrusted sender for ${channel}`)
    const parsed = args.safeParse(raw)
    if (!parsed.success) throw new Error(`Invalid arguments for ${channel}`)
    return fn(event, parsed.data as InvokeParsed<K>)
  })
}

/** A one-way channel: messages with invalid arguments or from a sender not allowed are dropped. */
export function listen<K extends SendName>(name: K, fn: SendHandler<K>): void {
  const { channel, args } = sends[name]
  ipcMain.on(channel, (event, ...raw: unknown[]) => {
    if (!allowed(event, name)) return
    const parsed = args.safeParse(raw)
    if (parsed.success) fn(event, parsed.data as SendParsed<K>)
  })
}

export function registerHandlers(invokeHandlers: InvokeHandlers, sendHandlers: SendHandlers): void {
  for (const name of Object.keys(invokes) as InvokeName[]) handle(name, invokeHandlers[name] as never)
  for (const name of Object.keys(sends) as SendName[]) listen(name, sendHandlers[name] as never)
}

export function emit<K extends EventName>(contents: WebContents, name: K, ...args: EventArgs<K>): void {
  contents.send(events[name].channel, ...args)
}
