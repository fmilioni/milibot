import { type BoardCardLink, type BoardCardLinkKind, type boardEndpoints, newId } from '@milibot/shared'

import { DaemonError, notFound } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import type { BoardService } from './service'

const UPLOAD_TTL_MS = 30 * 60_000

interface Upload {
  boardId: string
  name: string
  size: number
  chunks: Buffer[]
  received: number
  createdAt: number
}

/** The app's board routes; image uploads arrive in chunks kept in memory until complete. */
export class BoardRoutes {
  private readonly uploads = new Map<string, Upload>()

  constructor(private readonly deps: { boards: BoardService; now: () => number }) {}

  private upload(boardId: string, uploadId: string): Upload {
    const upload = this.uploads.get(uploadId)
    if (!upload || upload.boardId !== boardId) throw notFound('upload', uploadId)
    return upload
  }

  private dropStaleUploads(): void {
    const cutoff = this.deps.now() - UPLOAD_TTL_MS
    for (const [id, upload] of this.uploads) if (upload.createdAt < cutoff) this.uploads.delete(id)
  }

  private userLink(
    kind: BoardCardLinkKind,
    ref: string,
    label: string | undefined,
  ): Omit<BoardCardLink, 'id' | 'createdAt' | 'state'> {
    const target = this.deps.boards.linkTarget(kind, ref)
    if ('problem' in target) throw new DaemonError('validation_failed', target.problem, { reason: 'link' })
    return { kind, ref: target.ref, label: label || target.label, url: target.url }
  }

  handlers(): EndpointHandlers<keyof typeof boardEndpoints> {
    const { boards } = this.deps
    const USER = { type: 'user' as const, botId: null }
    return {
      listBoards: ({ query }) => boards.list(query.filter ?? 'all', query.projectId),
      createBoard: ({ body }) =>
        boards.detail(
          boards.createBoard({
            title: body.title,
            summary: body.summary ?? '',
            projectId: body.projectId ?? null,
            dueDate: body.dueDate ?? null,
            bot: null,
            conversationId: null,
          }),
        ),
      getBoard: ({ params }) => boards.detail(boards.requireBoard(params.boardId)),
      updateBoard: ({ params, body }) => boards.updateBoard(params.boardId, body),
      deleteBoard: ({ params }) => {
        boards.deleteBoard(params.boardId)
        return { ok: true as const }
      },
      reorderBoard: ({ params, body }) => boards.reorderBoard(params.boardId, body.index),
      createBoardCard: ({ params, body }) => {
        boards.requireBoard(params.boardId)
        const card = boards.addCard(params.boardId, {
          title: body.title,
          summary: body.summary ?? '',
          body: body.body ?? '',
          status: body.status ?? 'todo',
          dueDate: body.dueDate ?? null,
          createdByBotId: null,
          ...(body.assignees ? { assignees: body.assignees } : {}),
          ...(body.labelIds ? { labelIds: body.labelIds } : {}),
          ...(body.index !== undefined ? { index: body.index } : {}),
        })
        boards.changed(params.boardId, { cards: true, reindex: [card.id] })
        return boards.store.toCard(card)
      },
      getBoardCard: ({ params }) => boards.cardDetail(boards.requireCard(params.cardId, params.boardId)),
      updateBoardCard: ({ params, body }) => {
        boards.requireCard(params.cardId, params.boardId)
        const card = boards.updateCard(params.cardId, body)
        boards.changed(params.boardId, {
          cards: true,
          reindex: body.title !== undefined || body.summary !== undefined ? [card.id] : [],
        })
        return boards.store.toCard(card)
      },
      moveBoardCard: ({ params, body }) => {
        boards.requireCard(params.cardId, params.boardId)
        boards.moveCard(params.cardId, body.status, body.index, null)
        boards.changed(params.boardId, { cards: true })
        return boards.store.toCards(params.boardId)
      },
      moveBoardCardToBoard: ({ params, body }) => {
        boards.requireCard(params.cardId, params.boardId)
        const card = boards.moveCardToBoard(params.cardId, body.toBoardId, {
          ...(body.status ? { status: body.status } : {}),
          ...(body.index !== undefined ? { index: body.index } : {}),
          author: USER,
        })
        if (card.board_id === params.boardId) boards.changed(params.boardId, { cards: true })
        return boards.store.toCard(card)
      },
      deleteBoardCard: ({ params }) => {
        boards.requireCard(params.cardId, params.boardId)
        boards.deleteCard(params.cardId)
        return { ok: true as const }
      },
      addBoardComment: ({ params, body }) => {
        boards.requireCard(params.cardId, params.boardId)
        return boards.addComment(params.cardId, USER, body.body)
      },
      deleteBoardComment: ({ params }) => {
        boards.requireCard(params.cardId, params.boardId)
        const comment = boards.store.comment(params.commentId)
        if (!comment || comment.cardId !== params.cardId) throw notFound('comment', params.commentId)
        boards.store.deleteComment(params.commentId)
        boards.store.updateCard(params.cardId, {})
        boards.changed(params.boardId, { cards: true })
        return { ok: true as const }
      },
      addBoardCardLink: ({ params, body }) => {
        boards.requireCard(params.cardId, params.boardId)
        return boards.addLink(params.cardId, this.userLink(body.kind, body.ref, body.label))
      },
      deleteBoardCardLink: ({ params }) => {
        boards.requireCard(params.cardId, params.boardId)
        if (boards.store.linkCard(params.linkId) !== params.cardId) throw notFound('link', params.linkId)
        boards.store.removeLink(params.linkId)
        boards.changed(params.boardId, { cards: true })
        return { ok: true as const }
      },
      createBoardLabel: ({ params, body }) => {
        boards.requireBoard(params.boardId)
        return boards.addLabel(params.boardId, body.name, body.color)
      },
      updateBoardLabel: ({ params, body }) => boards.updateLabel(params.boardId, params.labelId, body),
      deleteBoardLabel: ({ params }) => {
        boards.deleteLabel(params.boardId, params.labelId)
        return { ok: true as const }
      },
      createBoardImage: ({ params, body }) => {
        boards.requireBoard(params.boardId)
        this.dropStaleUploads()
        const id = newId('boardUpload')
        this.uploads.set(id, {
          boardId: params.boardId,
          name: body.name,
          size: body.size,
          chunks: [],
          received: 0,
          createdAt: this.deps.now(),
        })
        return { id, name: body.name, size: body.size, received: 0 }
      },
      uploadBoardImageChunk: ({ params, body }) => {
        const upload = this.upload(params.boardId, params.uploadId)
        if (body.offset !== upload.received)
          throw new DaemonError('conflict', `Expected offset ${upload.received}`, {
            received: upload.received,
          })
        const chunk = Buffer.from(body.data, 'base64')
        if (upload.received + chunk.length > upload.size)
          throw new DaemonError('validation_failed', 'More bytes than the declared size')
        upload.chunks.push(chunk)
        upload.received += chunk.length
        return { received: upload.received }
      },
      completeBoardImage: async ({ params }) => {
        const upload = this.upload(params.boardId, params.uploadId)
        this.uploads.delete(params.uploadId)
        if (upload.received !== upload.size)
          throw new DaemonError('conflict', 'The upload is incomplete', { received: upload.received })
        return boards.addImage(params.boardId, new Uint8Array(Buffer.concat(upload.chunks)), upload.name)
      },
    }
  }
}
