export { MemoryBlobStore } from '../llm/blobs'
export { FakeProvider, type FakeScript, type FakeStep } from '../llm/fake'
export { solidPng } from '../media/png'
export { FakeBackend as FakeClaudeCodeBackend } from './claude-code'
export { FakeCodexBackend } from './codex'
export { createTestEnv, makeBot, screenshotTools, TestEnv } from './env'
export { InMemoryMemory } from './in-memory'
export { InMemoryWorkSessions } from './work-sessions'

/** An embedding worker that answers with deterministic vectors (no model download). */
export const FAKE_EMBEDDING_WORKER_URL = new URL('../embeddings/fixtures/fake-worker.mjs', import.meta.url)
