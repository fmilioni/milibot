import type { AppEvent, AppEventEnvelope, WorkspaceEvent, WorkspaceEventEnvelope } from '@milibot/shared'
import type { WebSocket } from 'ws'

const OPEN = 1

export class EventHub {
  private seq = 0
  private readonly appSockets = new Set<WebSocket>()
  private readonly workspaceSockets = new Map<string, Set<WebSocket>>()

  constructor(private readonly now: () => number = Date.now) {}

  addAppSocket(socket: WebSocket): void {
    this.appSockets.add(socket)
    socket.on('close', () => this.appSockets.delete(socket))
  }

  addWorkspaceSocket(workspaceId: string, socket: WebSocket): void {
    let set = this.workspaceSockets.get(workspaceId)
    if (!set) {
      set = new Set()
      this.workspaceSockets.set(workspaceId, set)
    }
    set.add(socket)
    socket.on('close', () => {
      set.delete(socket)
      if (set.size === 0) this.workspaceSockets.delete(workspaceId)
    })
  }

  publishApp(event: AppEvent): void {
    const frame: AppEventEnvelope = { seq: ++this.seq, at: this.now(), workspaceId: null, event }
    this.send(this.appSockets, frame)
  }

  publishWorkspace(workspaceId: string, event: WorkspaceEvent): void {
    const frame: WorkspaceEventEnvelope = { seq: ++this.seq, at: this.now(), workspaceId, event }
    this.send(this.workspaceSockets.get(workspaceId), frame)
  }

  sendTo(socket: WebSocket, workspaceId: string, event: WorkspaceEvent): void {
    const frame: WorkspaceEventEnvelope = { seq: ++this.seq, at: this.now(), workspaceId, event }
    this.send([socket], frame)
  }

  closeWorkspace(workspaceId: string): void {
    for (const socket of this.workspaceSockets.get(workspaceId) ?? []) socket.close(4404, 'workspace deleted')
    this.workspaceSockets.delete(workspaceId)
  }

  closeAll(): void {
    for (const socket of this.appSockets) socket.close(1001, 'daemon shutting down')
    for (const set of this.workspaceSockets.values()) {
      for (const socket of set) socket.close(1001, 'daemon shutting down')
    }
  }

  private send(sockets: Iterable<WebSocket> | undefined, frame: unknown): void {
    if (!sockets) return
    const data = JSON.stringify(frame)
    for (const socket of sockets) {
      if (socket.readyState === OPEN) socket.send(data)
    }
  }
}
