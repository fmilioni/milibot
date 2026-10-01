import { z } from 'zod'

import { UploadChunkBody, UploadChunkResult, UploadFileBody, UploadProgress } from '../chat/uploads'
import { UserOrBot } from '../core/schemas'
import { endpoint, Ok } from '../http/endpoint'

/*
 * Boards: a kanban a bot plans a large goal on. Each card is a piece of the goal big enough for its own plan
 * or work session; cards carry short comments, links (plans, sessions, pull requests, commits, designs) and
 * images in their markdown body (`asset:<sha>`). A board is done once every card is done or dropped;
 * archived boards leave what bots list unless they ask for them.
 */

export const BOARD_LIMITS = {
  title: 120,
  summary: 600,
  body: 20_000,
  /** Bots keep comments short: decisions, deviations, blockers. */
  botComment: 500,
  userComment: 5000,
  cards: 300,
  links: 40,
  imageBytes: 10 * 1024 * 1024,
  labels: 30,
  labelName: 40,
  assignees: 10,
} as const

/** Assignee that stands for the user (every other assignee is a bot id). */
export const BOARD_USER = 'user'

export const BOARD_LABEL_COLORS = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const
export const BoardLabelColor = z.enum(BOARD_LABEL_COLORS)
export type BoardLabelColor = z.infer<typeof BoardLabelColor>

export const BoardLabel = z.object({
  id: z.string(),
  boardId: z.string(),
  name: z.string(),
  color: BoardLabelColor,
})
export type BoardLabel = z.infer<typeof BoardLabel>

export const BoardCardStatus = z.enum(['todo', 'doing', 'done', 'dropped'])
export type BoardCardStatus = z.infer<typeof BoardCardStatus>
export const BOARD_CARD_STATUSES = BoardCardStatus.options

export const BoardStatus = z.enum(['active', 'done'])
export type BoardStatus = z.infer<typeof BoardStatus>

/** Local date `YYYY-MM-DD`. */
export const DueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const BoardCounts = z.object({
  todo: z.number().int(),
  doing: z.number().int(),
  done: z.number().int(),
  dropped: z.number().int(),
})
export type BoardCounts = z.infer<typeof BoardCounts>

export const Board = z.object({
  id: z.string(),
  title: z.string(),
  /** What the board is for (how boards are found later). */
  summary: z.string(),
  projectId: z.string().nullable(),
  /** null: made by the user. */
  botId: z.string().nullable(),
  /** Where its chat card is (null for boards the user made). */
  conversationId: z.string().nullable(),
  status: BoardStatus,
  counts: BoardCounts,
  dueDate: DueDate.nullable(),
  labels: z.array(BoardLabel),
  completedAt: z.number().int().nullable(),
  archivedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Board = z.infer<typeof Board>

export const BoardCardLinkKind = z.enum(['plan', 'session', 'design', 'pr', 'commit', 'url'])
export type BoardCardLinkKind = z.infer<typeof BoardCardLinkKind>

export const BoardCardLink = z.object({
  id: z.string(),
  kind: BoardCardLinkKind,
  /** Plan, session or design id; the URL of a pull request or link; a commit's sha. */
  ref: z.string(),
  label: z.string(),
  url: z.string().nullable(),
  /** Pull requests only: open, review, done (merged) or failed (closed), as last seen. */
  state: z.string().nullable(),
  createdAt: z.number().int(),
})
export type BoardCardLink = z.infer<typeof BoardCardLink>

/** A card without its body and comments (board view, events). */
export const BoardCard = z.object({
  id: z.string(),
  boardId: z.string(),
  title: z.string(),
  summary: z.string(),
  status: BoardCardStatus,
  /** Order inside its column, from 0. */
  position: z.number().int(),
  dueDate: DueDate.nullable(),
  /** Bot ids and `BOARD_USER`, in the order they were added (a bot moving it to doing joins). */
  assignees: z.array(z.string()),
  labelIds: z.array(z.string()),
  /** null: made by the user. */
  createdByBotId: z.string().nullable(),
  commentCount: z.number().int(),
  imageCount: z.number().int(),
  links: z.array(BoardCardLink),
  statusChangedAt: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type BoardCard = z.infer<typeof BoardCard>

export const BoardComment = z.object({
  id: z.string(),
  cardId: z.string(),
  authorType: UserOrBot,
  authorBotId: z.string().nullable(),
  body: z.string(),
  createdAt: z.number().int(),
})
export type BoardComment = z.infer<typeof BoardComment>

export const BoardDetail = Board.extend({ cards: z.array(BoardCard) })
export type BoardDetail = z.infer<typeof BoardDetail>

export const BoardCardDetail = BoardCard.extend({
  /** Markdown; images as `![name](asset:<sha>)`. */
  body: z.string(),
  comments: z.array(BoardComment),
})
export type BoardCardDetail = z.infer<typeof BoardCardDetail>

export const BoardListFilter = z.enum(['active', 'done', 'archived', 'all'])
export type BoardListFilter = z.infer<typeof BoardListFilter>

const ListBoardsQuery = z.object({
  /** `active`/`done`: not archived; `all`: archived included. */
  filter: BoardListFilter.optional(),
  projectId: z.string().optional(),
})

const Title = z.string().trim().min(1).max(BOARD_LIMITS.title)
const Assignees = z.array(z.string().min(1)).max(BOARD_LIMITS.assignees)
const LabelIds = z.array(z.string().min(1)).max(BOARD_LIMITS.labels)
const LabelName = z.string().trim().min(1).max(BOARD_LIMITS.labelName)
const Summary = z.string().trim().max(BOARD_LIMITS.summary)
const Body = z.string().max(BOARD_LIMITS.body)

const CreateBoardBody = z.object({
  title: Title,
  summary: Summary.optional(),
  projectId: z.string().nullable().optional(),
  dueDate: DueDate.nullable().optional(),
})

const UpdateBoardBody = z.object({
  title: Title.optional(),
  summary: Summary.optional(),
  projectId: z.string().nullable().optional(),
  dueDate: DueDate.nullable().optional(),
  archived: z.boolean().optional(),
})

const CreateBoardCardBody = z.object({
  title: Title,
  summary: Summary.optional(),
  body: Body.optional(),
  status: BoardCardStatus.optional(),
  dueDate: DueDate.nullable().optional(),
  assignees: Assignees.optional(),
  labelIds: LabelIds.optional(),
  /** Place in the column (default: the end). */
  index: z.number().int().min(0).optional(),
})

const UpdateBoardCardBody = z.object({
  title: Title.optional(),
  summary: Summary.optional(),
  body: Body.optional(),
  dueDate: DueDate.nullable().optional(),
  assignees: Assignees.optional(),
  labelIds: LabelIds.optional(),
})

const CreateBoardLabelBody = z.object({ name: LabelName, color: BoardLabelColor.optional() })
const UpdateBoardLabelBody = z.object({
  name: LabelName.optional(),
  color: BoardLabelColor.optional(),
})

const MoveBoardCardBody = z.object({ status: BoardCardStatus, index: z.number().int().min(0) })

const AddBoardCommentBody = z.object({
  body: z.string().trim().min(1).max(BOARD_LIMITS.userComment),
})

const AddBoardCardLinkBody = z.object({
  kind: BoardCardLinkKind,
  ref: z.string().trim().min(1).max(2000),
  label: z.string().trim().max(200).optional(),
})

const CreateBoardImageBody = UploadFileBody.extend({
  size: z.number().int().nonnegative().max(BOARD_LIMITS.imageBytes),
})

export const BoardImage = z.object({
  sha256: z.string(),
  name: z.string(),
  /** Where bots read it in the VM (copied when the VM runs). */
  path: z.string(),
  /** `![name](asset:<sha>)`, to put in a body or comment. */
  markdown: z.string(),
})
export type BoardImage = z.infer<typeof BoardImage>

const BOARD = '/w/:workspaceId/boards/:boardId'
const CARD = `${BOARD}/cards/:cardId`

export const boardEndpoints = {
  /** Newest first. */
  listBoards: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/boards',
    query: ListBoardsQuery,
    response: z.array(Board),
  }),
  createBoard: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/boards',
    body: CreateBoardBody,
    response: BoardDetail,
  }),
  getBoard: endpoint({ method: 'GET', path: BOARD, response: BoardDetail }),
  updateBoard: endpoint({ method: 'PATCH', path: BOARD, body: UpdateBoardBody, response: Board }),
  deleteBoard: endpoint({ method: 'DELETE', path: BOARD, response: Ok }),
  createBoardCard: endpoint({
    method: 'POST',
    path: `${BOARD}/cards`,
    body: CreateBoardCardBody,
    response: BoardCard,
  }),
  getBoardCard: endpoint({ method: 'GET', path: CARD, response: BoardCardDetail }),
  updateBoardCard: endpoint({ method: 'PATCH', path: CARD, body: UpdateBoardCardBody, response: BoardCard }),
  /** Returns the board's cards after the move. */
  moveBoardCard: endpoint({
    method: 'POST',
    path: `${CARD}/move`,
    body: MoveBoardCardBody,
    response: z.array(BoardCard),
  }),
  deleteBoardCard: endpoint({ method: 'DELETE', path: CARD, response: Ok }),
  addBoardComment: endpoint({
    method: 'POST',
    path: `${CARD}/comments`,
    body: AddBoardCommentBody,
    response: BoardComment,
  }),
  deleteBoardComment: endpoint({ method: 'DELETE', path: `${CARD}/comments/:commentId`, response: Ok }),
  addBoardCardLink: endpoint({
    method: 'POST',
    path: `${CARD}/links`,
    body: AddBoardCardLinkBody,
    response: BoardCardLink,
  }),
  deleteBoardCardLink: endpoint({ method: 'DELETE', path: `${CARD}/links/:linkId`, response: Ok }),
  createBoardLabel: endpoint({
    method: 'POST',
    path: `${BOARD}/labels`,
    body: CreateBoardLabelBody,
    response: BoardLabel,
  }),
  updateBoardLabel: endpoint({
    method: 'PATCH',
    path: `${BOARD}/labels/:labelId`,
    body: UpdateBoardLabelBody,
    response: BoardLabel,
  }),
  /** Removes the label from the board and from its cards. */
  deleteBoardLabel: endpoint({ method: 'DELETE', path: `${BOARD}/labels/:labelId`, response: Ok }),
  createBoardImage: endpoint({
    method: 'POST',
    path: `${BOARD}/images`,
    body: CreateBoardImageBody,
    response: UploadProgress,
  }),
  uploadBoardImageChunk: endpoint({
    method: 'POST',
    path: `${BOARD}/images/:uploadId/chunks`,
    body: UploadChunkBody,
    response: UploadChunkResult,
  }),
  completeBoardImage: endpoint({
    method: 'POST',
    path: `${BOARD}/images/:uploadId/complete`,
    response: BoardImage,
  }),
}
