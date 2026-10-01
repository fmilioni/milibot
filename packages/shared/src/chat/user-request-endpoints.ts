import { z } from 'zod'

import { endpoint } from '../http/endpoint'
import { Message } from './messages'
import { AnswerQuestionBody, AnswerSecretBody } from './user-requests'

// Apart from `user-requests.ts`, which the message payloads import.

const REQUEST = '/w/:workspaceId/user-requests/:requestId'

/** Answers to what a bot asked the user; each returns the updated card. */
export const userRequestEndpoints = {
  /** Answers are final: resolving an already resolved request returns the card unchanged. */
  answerSecretRequest: endpoint({
    method: 'POST',
    path: `${REQUEST}/secret`,
    body: AnswerSecretBody,
    response: Message,
  }),
  answerQuestion: endpoint({
    method: 'POST',
    path: `${REQUEST}/answer`,
    body: AnswerQuestionBody,
    response: Message,
  }),
  declineUserRequest: endpoint({ method: 'POST', path: `${REQUEST}/decline`, response: Message }),
  /** Approves or rejects an action a bot asked for. */
  resolveConfirmation: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/confirmations/:confirmationId/resolve',
    body: z.object({ approved: z.boolean() }),
    response: Message,
  }),
}
