import { randomBytes, timingSafeEqual } from 'node:crypto'

import websocket from '@fastify/websocket'
import {
  api,
  API_ERROR_STATUS,
  type ApiErrorBody,
  AUTH_QUERY_PARAM,
  type EndpointName,
  type EndpointResponse,
  EVENTS_PATH,
  type RuntimeStatus,
  WORKSPACE_EVENTS_PATH,
} from '@milibot/shared'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, LogController } from 'fastify'

import { toApiError } from '../errors'
import { type HandlerArgs, parseEndpointInput } from '../handlers'
import type { WorkspaceEndpointName } from '../ipc/protocol'
import type { EventHub } from './event-hub'

type AppEndpointName = Exclude<EndpointName, WorkspaceEndpointName>

export type AppHandlers = {
  [K in AppEndpointName]: (
    args: HandlerArgs<K> & { reply: FastifyReply },
  ) => EndpointResponse<K> | Promise<EndpointResponse<K>>
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

function tokensMatch(expected: string, received: string | undefined): boolean {
  if (!received) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Fastify with the daemon's logger, bearer (or `?token=`) auth, CORS and API error bodies. */
export function createHttpApp(options: {
  token: string
  logLevel: string
  logRequests: boolean
}): FastifyInstance {
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: !options.logRequests }),
    logger: {
      level: options.logLevel,
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          url: req.url.replace(new RegExp(`([?&]${AUTH_QUERY_PARAM}=)[^&]*`), '$1***'),
        }),
      },
    },
  })

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('access-control-allow-origin', '*')
    reply.header('access-control-allow-headers', 'authorization, content-type')
    reply.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    if (request.method === 'OPTIONS') return
    const header = request.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    const queryToken = (request.query as Record<string, string | undefined>)[AUTH_QUERY_PARAM]
    if (!tokensMatch(options.token, bearer ?? queryToken)) {
      const body: ApiErrorBody = { error: { code: 'unauthorized', message: 'Missing or invalid token' } }
      return reply.code(401).send(body)
    }
  })

  app.options('/*', async (_request, reply) => reply.code(204).send())

  app.setErrorHandler((err: unknown, request, reply) => {
    const { error, unexpected } = toApiError(err)
    if (unexpected) request.log.error({ err }, 'unhandled error')
    const body: ApiErrorBody = { error }
    return reply.code(API_ERROR_STATUS[error.code]).send(body)
  })

  return app
}

export interface RouteDeps {
  hub: EventHub
  appHandlers: AppHandlers
  workspaceExists: (workspaceId: string) => boolean
  runtimeStatus: (workspaceId: string) => RuntimeStatus
  /** A workspace route, answered by the workspace's runtime. */
  forward: (
    name: WorkspaceEndpointName,
    params: Record<string, string>,
    query: unknown,
    body: unknown,
  ) => unknown
}

/** The event sockets and every endpoint of `api`: app routes run here, workspace routes are forwarded. */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { hub } = deps
  void app.register(websocket)
  void app.register(async (instance) => {
    instance.get(EVENTS_PATH, { websocket: true }, (socket) => hub.addAppSocket(socket))

    instance.get(WORKSPACE_EVENTS_PATH, { websocket: true }, (socket, request) => {
      const { workspaceId } = request.params as { workspaceId: string }
      if (!deps.workspaceExists(workspaceId)) {
        socket.close(4404, 'workspace not found')
        return
      }
      hub.addWorkspaceSocket(workspaceId, socket)
      hub.sendTo(socket, workspaceId, {
        type: 'runtime.status',
        payload: { status: deps.runtimeStatus(workspaceId) },
      })
    })

    for (const [name, def] of Object.entries(api) as [EndpointName, (typeof api)[EndpointName]][]) {
      if (def.scope === 'workspace') {
        instance.route({
          method: def.method,
          url: def.path,
          handler: async (request) => {
            const query = { ...(request.query as Record<string, unknown>) }
            delete query[AUTH_QUERY_PARAM]
            return deps.forward(
              name as WorkspaceEndpointName,
              request.params as Record<string, string>,
              query,
              request.body,
            )
          },
        })
        continue
      }
      const handler = deps.appHandlers[name as AppEndpointName] as (
        args: HandlerArgs<AppEndpointName> & { reply: FastifyReply },
      ) => unknown
      instance.route({
        method: def.method,
        url: def.path,
        handler: async (request, reply) =>
          handler({
            ...parseEndpointInput(
              name as AppEndpointName,
              request.params as Record<string, string>,
              request.query,
              request.body,
            ),
            reply,
          }),
      })
    }
  })
}
