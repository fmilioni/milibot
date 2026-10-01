import {
  applyCardMove,
  type Board,
  type BoardCard,
  type BoardCardDetail,
  type BoardCardLinkKind,
  type BoardCardStatus,
  type BoardComment,
  type BoardImage,
  type BoardLabel,
  type BoardLabelColor,
  type WorkspaceEvent,
} from '@milibot/shared'
import { create } from 'zustand'

import { api } from '@/api/daemon'
import { createWorkspaceScope } from '@/api/workspace-scope'
import { uploadFile } from '@/features/chat/lib/attachment-upload'
import { removeById } from '@/lib/collections'

interface BoardState {
  /** Workspace the lists belong to (null: not loaded yet). */
  workspaceId: string | null
  /** Every board, archived ones included, newest first. */
  boards: Board[]
  loaded: boolean
  /** Cards per board, loaded when a board is opened and then kept current by events. */
  cards: Record<string, BoardCard[]>

  load(workspaceId: string): Promise<void>
  loadCards(workspaceId: string, boardId: string): Promise<void>
  createBoard(
    workspaceId: string,
    body: { title: string; summary?: string; dueDate?: string | null },
  ): Promise<Board>
  updateBoard(
    workspaceId: string,
    boardId: string,
    patch: { title?: string; summary?: string; dueDate?: string | null; archived?: boolean },
  ): Promise<void>
  deleteBoard(workspaceId: string, boardId: string): Promise<void>
  addCard(
    workspaceId: string,
    boardId: string,
    body: { title: string; status?: BoardCardStatus },
  ): Promise<BoardCard>
  updateCard(
    workspaceId: string,
    boardId: string,
    cardId: string,
    patch: {
      title?: string
      summary?: string
      body?: string
      dueDate?: string | null
      assignees?: string[]
      labelIds?: string[]
    },
  ): Promise<void>
  createLabel(
    workspaceId: string,
    boardId: string,
    body: { name: string; color?: BoardLabelColor },
  ): Promise<BoardLabel>
  updateLabel(
    workspaceId: string,
    boardId: string,
    labelId: string,
    patch: { name?: string; color?: BoardLabelColor },
  ): Promise<void>
  deleteLabel(workspaceId: string, boardId: string, labelId: string): Promise<void>
  /** Moves at once, then keeps what the daemon answers (or goes back when it fails). */
  moveCard(
    workspaceId: string,
    boardId: string,
    cardId: string,
    status: BoardCardStatus,
    index: number,
  ): Promise<void>
  deleteCard(workspaceId: string, boardId: string, cardId: string): Promise<void>
  cardDetail(workspaceId: string, boardId: string, cardId: string): Promise<BoardCardDetail>
  addComment(workspaceId: string, boardId: string, cardId: string, body: string): Promise<BoardComment>
  deleteComment(workspaceId: string, boardId: string, cardId: string, commentId: string): Promise<void>
  addLink(
    workspaceId: string,
    boardId: string,
    cardId: string,
    link: { kind: BoardCardLinkKind; ref: string; label?: string },
  ): Promise<void>
  deleteLink(workspaceId: string, boardId: string, cardId: string, linkId: string): Promise<void>
  uploadImage(workspaceId: string, boardId: string, file: File): Promise<BoardImage>
  applyEvent(workspaceId: string, event: WorkspaceEvent): void
}

const byUpdate = (boards: Board[]) => [...boards].sort((a, b) => b.updatedAt - a.updatedAt)

export const useBoardStore = create<BoardState>()((set, get) => {
  const {
    forWorkspace,
    isCurrent: current,
    commit,
  } = createWorkspaceScope(get, set, () => ({ boards: [], cards: {}, loaded: false }))
  const setCards = (boardId: string, cards: BoardCard[]) =>
    set({ cards: { ...get().cards, [boardId]: cards } })

  return {
    workspaceId: null,
    boards: [],
    loaded: false,
    cards: {},

    async load(workspaceId) {
      forWorkspace(workspaceId)
      const boards = await api().call('listBoards', { params: { workspaceId }, query: { filter: 'all' } })
      commit(workspaceId, { boards: byUpdate(boards), loaded: true })
    },

    async loadCards(workspaceId, boardId) {
      forWorkspace(workspaceId)
      const detail = await api().call('getBoard', { params: { workspaceId, boardId } })
      if (!current(workspaceId)) return
      const { cards, ...board } = detail
      set({ boards: byUpdate([...removeById(get().boards, board.id), board]) })
      setCards(boardId, cards)
    },

    async createBoard(workspaceId, body) {
      const detail = await api().call('createBoard', { params: { workspaceId }, body })
      const { cards, ...board } = detail
      if (current(workspaceId)) {
        set({ boards: byUpdate([...removeById(get().boards, board.id), board]) })
        setCards(board.id, cards)
      }
      return board
    },

    async updateBoard(workspaceId, boardId, patch) {
      const board = await api().call('updateBoard', { params: { workspaceId, boardId }, body: patch })
      commit(workspaceId, () => ({ boards: byUpdate([...removeById(get().boards, boardId), board]) }))
    },

    async deleteBoard(workspaceId, boardId) {
      await api().call('deleteBoard', { params: { workspaceId, boardId } })
      get().applyEvent(workspaceId, { type: 'board.deleted', payload: { boardId } })
    },

    addCard: (workspaceId, boardId, body) =>
      api().call('createBoardCard', { params: { workspaceId, boardId }, body }),

    async updateCard(workspaceId, boardId, cardId, patch) {
      await api().call('updateBoardCard', { params: { workspaceId, boardId, cardId }, body: patch })
    },

    createLabel: (workspaceId, boardId, body) =>
      api().call('createBoardLabel', { params: { workspaceId, boardId }, body }),

    async updateLabel(workspaceId, boardId, labelId, patch) {
      await api().call('updateBoardLabel', { params: { workspaceId, boardId, labelId }, body: patch })
    },

    async deleteLabel(workspaceId, boardId, labelId) {
      await api().call('deleteBoardLabel', { params: { workspaceId, boardId, labelId } })
    },

    async moveCard(workspaceId, boardId, cardId, status, index) {
      const before = get().cards[boardId]
      if (before) setCards(boardId, applyCardMove(before, cardId, status, index))
      try {
        const cards = await api().call('moveBoardCard', {
          params: { workspaceId, boardId, cardId },
          body: { status, index },
        })
        if (current(workspaceId)) setCards(boardId, cards)
      } catch (err) {
        if (before && current(workspaceId)) setCards(boardId, before)
        throw err
      }
    },

    async deleteCard(workspaceId, boardId, cardId) {
      await api().call('deleteBoardCard', { params: { workspaceId, boardId, cardId } })
      const cards = get().cards[boardId]
      if (cards && current(workspaceId)) setCards(boardId, removeById(cards, cardId))
    },

    cardDetail: (workspaceId, boardId, cardId) =>
      api().call('getBoardCard', { params: { workspaceId, boardId, cardId } }),

    addComment: (workspaceId, boardId, cardId, body) =>
      api().call('addBoardComment', { params: { workspaceId, boardId, cardId }, body: { body } }),

    async deleteComment(workspaceId, boardId, cardId, commentId) {
      await api().call('deleteBoardComment', { params: { workspaceId, boardId, cardId, commentId } })
    },

    async addLink(workspaceId, boardId, cardId, link) {
      await api().call('addBoardCardLink', { params: { workspaceId, boardId, cardId }, body: link })
    },

    async deleteLink(workspaceId, boardId, cardId, linkId) {
      await api().call('deleteBoardCardLink', { params: { workspaceId, boardId, cardId, linkId } })
    },

    uploadImage: (workspaceId, boardId, file) =>
      uploadFile(file, {
        create: (body) => api().call('createBoardImage', { params: { workspaceId, boardId }, body }),
        chunk: (uploadId, offset, data) =>
          api().call('uploadBoardImageChunk', {
            params: { workspaceId, boardId, uploadId },
            body: { offset, data },
          }),
        complete: (uploadId) =>
          api().call('completeBoardImage', { params: { workspaceId, boardId, uploadId } }),
      }),

    applyEvent(workspaceId, event) {
      if (!current(workspaceId)) return
      switch (event.type) {
        case 'board.updated':
          set({
            boards: byUpdate([...removeById(get().boards, event.payload.board.id), event.payload.board]),
          })
          break
        case 'board.cards.updated':
          if (get().cards[event.payload.boardId] || get().loaded)
            setCards(event.payload.boardId, event.payload.cards)
          break
        case 'board.deleted': {
          const { [event.payload.boardId]: _gone, ...cards } = get().cards
          set({ boards: removeById(get().boards, event.payload.boardId), cards })
          break
        }
      }
    },
  }
})
