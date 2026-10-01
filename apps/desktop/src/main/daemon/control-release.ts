import type { ApiClient } from '@milibot/shared'

type ControlClient = Pick<ApiClient, 'call'>

/** Gives a bot's screen back when the user still holds it; resolves to whether it released. */
export async function releaseUserControl(
  client: ControlClient,
  workspaceId: string,
  botId: string,
): Promise<boolean> {
  const params = { workspaceId, botId }
  const display = await client.call('getBotDisplay', { params })
  if (display.control !== 'user') return false
  await client.call('controlBot', { params, body: { action: 'release' } })
  return true
}

/** Every screen the user holds in these workspaces goes back to its bot, giving up after `timeoutMs`. */
export async function releaseWorkspaces(
  client: ControlClient,
  workspaceIds: string[],
  timeoutMs: number,
): Promise<void> {
  const work = Promise.allSettled(
    workspaceIds.map(async (workspaceId) => {
      const bots = await client.call('listBots', { params: { workspaceId } })
      await Promise.allSettled(bots.map((bot) => releaseUserControl(client, workspaceId, bot.id)))
    }),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  await Promise.race([work, timeout])
  clearTimeout(timer)
}
