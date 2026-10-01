import {
  type EmbeddingProvider,
  type EmbeddingSetting,
  FakeEmbeddingProvider,
} from '@milibot/agent/embeddings'

/** Deterministic embeddings, one vector space per setting (tests, `MILIBOT_FAKE_EMBEDDINGS=1`). */
export function fakeEmbeddingFactory(dimensions = 64) {
  return async (setting: EmbeddingSetting): Promise<EmbeddingProvider> =>
    new FakeEmbeddingProvider({
      dimensions,
      key: `fake:${setting.provider === 'local' ? `${setting.family}:${setting.level}` : `${setting.providerId}:${setting.model}`}:${dimensions}`,
    })
}
