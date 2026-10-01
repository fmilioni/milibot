/**
 * Antigravity CLI (`agy`) version installed in the VM: the tarball of that build, checked against its sha512
 * (Google's release manifest, `…/manifests/linux_<arch>.json`). Pinned: the stream-json events and the agent
 * file format change between releases, so a bump means re-checking `packages/agent/src/antigravity/`.
 */
export const ANTIGRAVITY_VERSION = '1.2.14'

/** Release build of `ANTIGRAVITY_VERSION` (part of its download path). */
export const ANTIGRAVITY_BUILD = '1.2.14-4571742832820224'

/** Tarball and sha512 of `ANTIGRAVITY_VERSION` per VM architecture (`uname -m`). */
export const ANTIGRAVITY_DOWNLOADS = {
  aarch64: {
    path: 'linux-arm/cli_linux_arm64.tar.gz',
    sha512:
      'd96a67d6952a8ec1da16c8b6515f1393ed0260658cf104d9b57b8d13c92c591322ed5e08a62894842be81888116da0f5f80def7971c913d1f462300103426954',
  },
  x86_64: {
    path: 'linux-x64/cli_linux_x64.tar.gz',
    sha512:
      'fd771dfc74ddd07b61c8b0a6fd7a238f53a3a098a51052583a01d97ab84ee60db741ce5f041e87a9da3c1a9aabe95b053113374437df1e231773552781edaf09',
  },
} as const

export const ANTIGRAVITY_DOWNLOAD_BASE = 'https://storage.googleapis.com/antigravity-public/antigravity-cli'

/**
 * Models `agy models` lists for a Google AI subscription in `ANTIGRAVITY_VERSION`, by the base id `--model`
 * takes (the effort goes in `--effort`; the CLI refuses a level the model lacks). Prices are the Gemini API's
 * Standard paid tier (and Anthropic's for its models): what the turn would have cost outside the plan.
 */
export const ANTIGRAVITY_MODELS = [
  {
    id: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    contextWindow: 1_048_576,
    efforts: ['low', 'medium', 'high'],
    input: 1.5,
    cacheRead: 0.15,
    output: 7.5,
  },
  {
    id: 'gemini-3.1-pro',
    displayName: 'Gemini 3.1 Pro',
    contextWindow: 1_048_576,
    efforts: ['low', 'high'],
    input: 2,
    cacheRead: 0.2,
    output: 12,
  },
  {
    id: 'gemini-3.7-flash',
    displayName: 'Gemini 3.7 Flash',
    contextWindow: 1_048_576,
    efforts: ['low', 'medium', 'high'],
    input: 1.5,
    cacheRead: 0.15,
    output: 7.5,
  },
  {
    id: 'gemini-3.6-flash',
    displayName: 'Gemini 3.6 Flash',
    contextWindow: 1_048_576,
    efforts: ['low', 'medium', 'high'],
    input: 1.5,
    cacheRead: 0.15,
    output: 7.5,
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    contextWindow: 200_000,
    efforts: [],
    input: 3,
    cacheRead: 0.3,
    output: 15,
  },
  {
    id: 'claude-opus-4-6-thinking',
    displayName: 'Claude Opus 4.6',
    contextWindow: 200_000,
    efforts: [],
    input: 5,
    cacheRead: 0.5,
    output: 25,
  },
  { id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B', contextWindow: 131_072, efforts: [] },
] as const
