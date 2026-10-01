import type { EmbeddingOptions, KnowledgeDoc, KnowledgeIndexStatus } from '@milibot/shared'
import i18next, { type TFunction } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en'
import ptBR from '@/i18n/locales/pt-BR'

import {
  apiEmbeddingModel,
  decodeEmbedding,
  docDetailLine,
  docErrorView,
  docStatusView,
  embeddingChoices,
  embeddingTriggerParts,
  encodeEmbedding,
  formatPrice,
  formatRam,
  hitLocation,
  indexStatusView,
  snippetText,
  splitPages,
  uploadProblemFromError,
  validateUpload,
} from './knowledge'

// Portuguese on purpose: asserts the pt-BR knowledge texts.

let t: TFunction
let tEn: TFunction

beforeAll(async () => {
  const instance = i18next.createInstance()
  await instance.init({
    lng: 'pt-BR',
    resources: { 'pt-BR': { translation: ptBR }, en: { translation: en } },
    interpolation: { escapeValue: false },
  })
  t = instance.getFixedT('pt-BR')
  tEn = instance.getFixedT('en')
})

const level = (
  id: string,
  dimensions: number,
  extra: Partial<EmbeddingOptions['local'][number]['levels'][number]> = {},
) => ({
  id,
  dimensions,
  maxInputTokens: 2048,
  ramMb: 720,
  downloadBytes: 218_726_989,
  recommended: false,
  downloaded: true,
  diskBytes: 218_726_989,
  downloadProgress: null,
  spaceKey: `local:gemma:${dimensions}`,
  ...extra,
})

const OPTIONS: EmbeddingOptions = {
  current: { provider: 'local', family: 'embeddinggemma', level: 'max' },
  local: [
    {
      id: 'embeddinggemma',
      name: 'EmbeddingGemma',
      vendor: 'Google',
      levels: [level('max', 768, { recommended: true }), level('balanced', 512), level('compact', 256)],
    },
    {
      id: 'multilingual-e5',
      name: 'multilingual-e5',
      vendor: 'Microsoft',
      levels: [
        level('small', 384, { ramMb: 980, downloadBytes: 135_392_016, maxInputTokens: 512 }),
        level('base', 768, { ramMb: 1290, downloadBytes: 295_731_426, maxInputTokens: 512 }),
        level('large', 1024, { ramMb: 2080, downloadBytes: 578_852_632, maxInputTokens: 512 }),
      ],
    },
  ],
  api: [],
}

const OPENROUTER: EmbeddingOptions['api'][number] = {
  providerId: 'prov_or',
  name: 'OpenRouter',
  preset: 'openrouter',
  local: false,
  models: [
    {
      model: 'qwen/qwen3-embedding-4b',
      name: 'Qwen: Qwen3 Embedding 4B',
      dimensions: 2560,
      maxInputTokens: 32_768,
      priceInputPerMtokUsd: 0.02,
    },
    {
      model: 'qwen/qwen3-embedding-8b',
      name: 'Qwen: Qwen3 Embedding 8B',
      dimensions: null,
      maxInputTokens: 32_768,
      priceInputPerMtokUsd: 0.01,
    },
    {
      model: 'openai/text-embedding-3-small',
      name: 'OpenAI: Text Embedding 3 Small',
      dimensions: null,
      maxInputTokens: null,
      priceInputPerMtokUsd: null,
    },
  ],
}

function doc(patch: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return {
    id: 'kdoc_1',
    title: 'Contract.pdf',
    fileName: 'Contract.pdf',
    mime: 'application/pdf',
    kind: 'pdf',
    source: 'upload',
    sourceRef: null,
    authorType: 'user',
    authorBotId: null,
    conversationId: null,
    bytes: 13_002_342,
    sha256: null,
    pages: 48,
    chunks: 212,
    status: 'ready',
    errorCode: null,
    error: null,
    progress: 1,
    summary: null,
    summaryModel: null,
    ocrPages: 0,
    pinned: false,
    lastUsedAt: null,
    scope: 'all',
    projectId: null,
    embedded: true,
    createdAt: Date.now() - 2 * 86_400_000,
    updatedAt: Date.now(),
    indexedAt: Date.now(),
    ...patch,
  }
}

const INDEX: KnowledgeIndexStatus = {
  state: 'idle',
  embedding: { provider: 'local', family: 'embeddinggemma', level: 'max' },
  activeSpace: 'local:gemma:768',
  targetSpace: null,
  download: null,
  indexedChunks: 2431,
  totalChunks: 2431,
  pendingDocs: 0,
  waitingForVm: 0,
  error: null,
}

describe('search model options', () => {
  it('round-trips the setting through the select value', () => {
    for (const setting of [
      OPTIONS.current,
      { provider: 'api' as const, providerId: 'prov_1', model: 'nomic-embed-text:latest' },
    ])
      expect(decodeEmbedding(encodeEmbedding(setting))).toEqual(setting)
    expect(decodeEmbedding('garbage')).toBeNull()
  })

  it('groups local families with measured RAM, download size and index share', () => {
    const choices = embeddingChoices(OPTIONS, t, 'pt-BR')
    const gemma = choices.options.filter((o) => o.group === 'local:embeddinggemma')
    expect(gemma.map((o) => [o.label, o.badge, o.meta, o.metaDetail])).toEqual([
      ['Precisão máxima', 'Recomendado', '~720 MB de RAM', '209 MB · índice 100%'],
      ['Equilibrado', undefined, '~720 MB de RAM', '209 MB · índice 67%'],
      ['Compacto', undefined, '~720 MB de RAM', '209 MB · índice 33%'],
    ])
    expect(gemma[1]?.description).toBe('512 dimensões · quase a mesma precisão')
    const e5 = choices.options.filter((o) => o.group === 'local:multilingual-e5')
    expect(e5.map((o) => [o.label, o.meta, o.metaDetail])).toEqual([
      ['Pequeno', '~980 MB de RAM', '129 MB'],
      ['Médio', '~1,3 GB de RAM', '282 MB'],
      ['Grande', '~2 GB de RAM', '552 MB'],
    ])
    expect(choices.groups['local:embeddinggemma']).toMatchObject({
      title: 'EmbeddingGemma',
      vendor: 'Google',
      tag: { label: 'Neste computador' },
      description: 'Um modelo, três tamanhos de índice · trechos até 2k tokens',
    })
    expect(embeddingTriggerParts(choices, choices.value)).toEqual({
      where: 'Neste computador',
      name: 'EmbeddingGemma · Precisão máxima',
      badge: 'Recomendado',
    })
  })

  it('points to "Providers and models" when no search model is registered', () => {
    const none = embeddingChoices(OPTIONS, t, 'pt-BR')
    expect(none.options.filter((o) => o.group === 'api:none').map((o) => [o.label, o.disabled])).toEqual([
      ['Nenhum modelo de busca cadastrado', true],
    ])
    expect(none.groups['api:none']?.description).toMatch(/provedor compatível com OpenAI/)
    const empty = embeddingChoices({ ...OPTIONS, api: [{ ...OPENROUTER, models: [] }] }, t, 'pt-BR')
    expect(empty.groups['api:none']?.description).toMatch(/^Cadastre modelos de busca/)
  })

  it('lists the registered models per provider with their registered price, size and input', () => {
    const choices = embeddingChoices({ ...OPTIONS, api: [OPENROUTER] }, tEn, 'en')
    const qwen = choices.options.filter((o) => o.group === 'api:prov_or:qwen')
    expect(qwen.map((o) => [o.label, o.description, o.meta, o.metaDetail])).toEqual([
      ['4B', '2,560 dimensions · up to 32k tokens', '$0.02', 'per 1M tokens'],
      ['8B', 'dimensions measured when chosen · up to 32k tokens', '$0.01', 'per 1M tokens'],
    ])
    expect(choices.groups['api:prov_or:qwen']?.description).toMatch(/leave your computer/)
    const local = embeddingChoices(
      { ...OPTIONS, api: [{ ...OPENROUTER, name: 'Ollama', local: true }] },
      tEn,
      'en',
    )
    expect(local.groups['api:prov_or:qwen']?.description).toMatch(/do not leave/)
    expect(choices.groups['api:prov_or:qwen']?.tag?.label).toBe('Via OpenRouter')
    const other = choices.options.filter((o) => o.group === 'api:prov_or:models')
    expect(other.map((o) => [o.label, o.description, o.meta, o.metaDetail])).toEqual([
      ['OpenAI: Text Embedding 3 Small', 'dimensions measured when chosen', 'No price registered', undefined],
    ])
    expect(choices.options.some((o) => o.disabled)).toBe(false)
    expect(choices.groups['api:none']).toBeUndefined()
    const current = choices.options[choices.options.length - 1]!.value
    expect(embeddingTriggerParts(choices, current)).toEqual({
      where: 'Via OpenRouter',
      name: 'OpenAI: Text Embedding 3 Small',
      badge: null,
    })
    expect(embeddingTriggerParts(choices, qwen[0]!.value).name).toBe('Qwen3 Embedding · 4B')
  })

  it('finds the registered model behind a setting', () => {
    const options = { ...OPTIONS, api: [OPENROUTER] }
    const setting = { provider: 'api' as const, providerId: 'prov_or', model: 'qwen/qwen3-embedding-8b' }
    expect(apiEmbeddingModel(options, setting)?.dimensions).toBeNull()
    expect(apiEmbeddingModel(options, { ...setting, model: 'x' })).toBeNull()
    expect(apiEmbeddingModel(options, OPTIONS.current)).toBeNull()
  })

  it('keeps a current API model that is not registered, marked unavailable', () => {
    const current = { provider: 'api' as const, providerId: 'prov_gone', model: 'x/embed' }
    const choices = embeddingChoices({ ...OPTIONS, current }, t, 'pt-BR')
    const option = choices.options.find((o) => o.value === choices.value)
    expect(option?.label).toBe('x/embed')
    expect(choices.groups[option?.group ?? '']?.title).toBe('Indisponível — cadastre o modelo')
    expect(embeddingTriggerParts(choices, choices.value)).toEqual({
      where: 'Indisponível — cadastre o modelo',
      name: 'x/embed',
      badge: null,
    })
  })
})

describe('index status line', () => {
  it('describes a downloaded model with disk, RAM and indexed passages', () => {
    const view = indexStatusView(INDEX, OPTIONS, t, 'pt-BR')
    expect(view.text).toBe(
      'Modelo baixado · 209 MB no disco · usa ~720 MB de RAM enquanto indexa · 2.431 trechos indexados',
    )
    expect(view.tone).toBe('success')
  })

  it('shows download progress, reindexing and documents waiting for the VM', () => {
    const downloading = indexStatusView(
      {
        ...INDEX,
        state: 'downloading',
        download: {
          modelId: 'gemma',
          progress: 0.5,
          loadedBytes: 110 * 1024 ** 2,
          totalBytes: 220 * 1024 ** 2,
        },
      },
      OPTIONS,
      t,
      'pt-BR',
    )
    expect(downloading.text).toBe('Baixando o modelo · 110 MB de 220 MB · 50%')
    expect(downloading.progress).toBe(0.5)
    const reindexing = indexStatusView(
      { ...INDEX, state: 'reindexing', indexedChunks: 100, totalChunks: 400, waitingForVm: 2 },
      OPTIONS,
      t,
      'pt-BR',
    )
    expect(reindexing.text).toMatch(/^Reindexando com o modelo novo · 100 de 400 trechos · .*modelo anterior/)
    expect(reindexing.text).toMatch(/2 documentos esperando a máquina ligar$/)
    expect(reindexing.progress).toBe(0.25)
  })

  it('offers a retry when the model is unavailable, with a humanized reason', () => {
    const view = indexStatusView(
      {
        ...INDEX,
        state: 'unavailable',
        error: { code: 'model_download_failed', message: 'ENOTFOUND huggingface.co' },
      },
      OPTIONS,
      t,
      'pt-BR',
    )
    expect(view.retry).toBe(true)
    expect(view.text).toMatch(/não deu para baixar o modelo/)
    expect(view.error).toBe('ENOTFOUND huggingface.co')
    const unregistered = indexStatusView(
      {
        ...INDEX,
        state: 'unavailable',
        error: { code: 'model_not_registered', message: 'not registered' },
      },
      OPTIONS,
      t,
      'pt-BR',
    )
    expect(unregistered.text).toMatch(/não está cadastrado em Provedores e modelos/)
    const notRegisteredYet = indexStatusView(
      {
        ...INDEX,
        state: 'idle',
        embedding: { provider: 'api', providerId: 'prov_or', model: 'gone/model' },
      },
      { ...OPTIONS, api: [OPENROUTER] },
      t,
      'pt-BR',
    )
    expect(notRegisteredYet).toMatchObject({ tone: 'danger', retry: false })
    expect(notRegisteredYet.text).toMatch(/não está cadastrado/)
  })
})

describe('document rows', () => {
  const ctx = {
    bots: {
      bot_v: { id: 'bot_v', name: 'Sales' },
      bot_c: { id: 'bot_c', name: 'Chief' },
    } as never,
    conversations: {
      conv_1: { id: 'conv_1', type: 'direct', memberBotIds: ['bot_c'], title: null },
    } as never,
    vmRunning: true,
    now: Date.now(),
  }

  it('reads like the design: pages, passages, origin and when', () => {
    expect(docDetailLine(doc({ source: 'attachment', conversationId: 'conv_1' }), ctx, t, 'pt-BR')).toBe(
      '48 páginas · 212 trechos · anexado por você na conversa com Chief · anteontem',
    )
    expect(
      docDetailLine(
        doc({
          kind: 'csv',
          pages: 840,
          chunks: 38,
          source: 'vm_file',
          sourceRef: '/workspace/prices/table.csv',
          authorType: 'bot',
          authorBotId: 'bot_v',
        }),
        ctx,
        t,
        'pt-BR',
      ),
    ).toMatch(/^840 linhas · 38 trechos · adicionado por Sales em \/workspace\/prices · /)
    expect(docDetailLine(doc({ pages: 3, ocrPages: 3, chunks: 4 }), ctx, t, 'pt-BR')).toMatch(
      /^3 páginas lidas por OCR · 4 trechos · /,
    )
  })

  it('waits for the VM only for files read there', () => {
    const queued = doc({ status: 'queued', progress: 0 })
    expect(docStatusView(queued, false, t).label).toBe('Aguardando a máquina ligar')
    expect(docDetailLine(queued, { ...ctx, vmRunning: false }, t, 'pt-BR')).toBe(
      '12 MB · será lido quando a VM ligar',
    )
    expect(docStatusView(doc({ status: 'queued', kind: 'markdown' }), false, t).label).toBe('Na fila')
    expect(docStatusView(queued, true, t).label).toBe('Na fila')
  })

  it('shows progress while reading and indexing', () => {
    const view = docStatusView(doc({ status: 'indexing', progress: 0.45 }), true, t)
    expect(view).toEqual({ tone: 'progress', label: 'Indexando · 45%', progress: 0.45 })
  })

  it('explains failures and points missing tools to the system update', () => {
    const missing = doc({ status: 'failed', errorCode: 'tools_missing' })
    expect(docStatusView(missing, true, t).tone).toBe('danger')
    expect(docErrorView(missing, t)).toEqual({
      hint: 'Atualize o sistema da máquina virtual para ler este arquivo',
      updateSystem: true,
      legacyOffice: null,
    })
    expect(docErrorView(doc({ status: 'failed', errorCode: 'legacy_office_disabled' }), t)).toMatchObject({
      updateSystem: false,
      legacyOffice: 'enable',
    })
    expect(docErrorView(doc({ status: 'failed', errorCode: 'office_missing' }), t).legacyOffice).toBe('retry')
    const unknown = doc({ status: 'failed', errorCode: 'weird' })
    expect(docStatusView(unknown, true, t).label).toBe('Algo deu errado')
    expect(docDetailLine(doc({ status: 'failed', errorCode: 'unsupported_format' }), ctx, t, 'pt-BR')).toBe(
      'Salve como PDF, .docx, .xlsx ou .csv e envie de novo',
    )
  })
})

describe('formatting', () => {
  it('formats RAM and prices', () => {
    expect(formatRam(720, 'pt-BR')).toBe('~720 MB')
    expect(formatRam(2080, 'pt-BR')).toBe('~2 GB')
    expect(formatPrice(0.02, 'en')).toBe('$0.02')
    expect(formatPrice(0.005, 'en')).toBe('$0.005')
  })

  it('splits extracted text at page markers', () => {
    expect(splitPages('Cover\n<!-- page 1 -->\nOne\n\n<!-- page 2 -->\nTwo')).toEqual([
      { page: null, text: 'Cover' },
      { page: 1, text: 'One' },
      { page: 2, text: 'Two' },
    ])
    expect(splitPages('just text')).toEqual([{ page: null, text: 'just text' }])
  })

  it('turns a passage into a plain preview', () => {
    expect(snippetText('# Glossary\n\n- **SLA**: deadline\n<!-- page 2 -->\n## End')).toBe(
      'Glossary\n- SLA: deadline\nEnd',
    )
  })

  it('describes where a passage was found', () => {
    const hit = { pageFrom: 12, pageTo: 13, heading: 'Contract › Payment' }
    expect(hitLocation(hit as never, t)).toBe('p. 12–13 · Contract › Payment')
    expect(hitLocation({ pageFrom: null, pageTo: null, heading: '' } as never, t)).toBe('')
  })
})

describe('uploads', () => {
  it('refuses files above the limit and formats that are certainly not text', () => {
    expect(validateUpload({ name: 'a.pdf', size: 51 * 1024 * 1024 }, 50)).toBe('too_large')
    expect(validateUpload({ name: 'old-sheet.XLS', size: 10 }, 50)).toBe('legacy_office_disabled')
    expect(validateUpload({ name: 'old-sheet.XLS', size: 10 }, 50, true)).toBeNull()
    expect(validateUpload({ name: 'slides.odp', size: 10 }, 50)).toBe('legacy_office_disabled')
    expect(validateUpload({ name: 'code.zip', size: 10 }, 50, true)).toBe('unsupported_format')
    expect(validateUpload({ name: 'Makefile', size: 10 }, 50)).toBeNull()
    expect(validateUpload({ name: 'notes.md', size: 50 * 1024 * 1024 }, 50)).toBeNull()
  })

  it('reads the reason of a refused upload', () => {
    expect(uploadProblemFromError({ reason: 'too_large', maxFileMb: 20 })).toEqual({
      problem: 'too_large',
      maxFileMb: 20,
    })
    expect(uploadProblemFromError({ reason: 'unsupported_format' })).toEqual({
      problem: 'unsupported_format',
    })
    expect(uploadProblemFromError({ reason: 'unsupported_format', hint: 'legacy_office_disabled' })).toEqual({
      problem: 'legacy_office_disabled',
    })
    expect(uploadProblemFromError(undefined)).toEqual({ problem: 'failed' })
  })
})
