/**
 * Relevance calibration data for the knowledge eval, in pt-BR like the corpus: a catalog summary per
 * corpus document (2–4 sentences, like the ones the summary model writes) and chat messages labeled
 * with the documents a per-turn suggestion should bring up. Most messages are not about any document
 * (greetings, thanks, requests to the team, code, unrelated questions): the suggestion must stay silent
 * for them.
 *
 * Portuguese on purpose: pt-BR summaries and messages, like the corpus.
 */
import { PASSAGES } from './corpus'

export interface EvalDoc {
  title: string
  summary: string
}

export const DOCS: EvalDoc[] = [
  {
    title: 'Contrato de serviços Alfa × Beta',
    summary:
      'Contrato de prestação de serviços de TI entre a Alfa Sistemas (contratada) e a Beta Logística (contratante). Define mensalidade de R$ 18.500 com reajuste anual pelo IPCA, multa e juros por atraso, rescisão com aviso de 60 dias, confidencialidade, proteção de dados (LGPD) e foro em Campinas. Os anexos trazem os níveis de serviço por severidade e as janelas de manutenção programada.',
  },
  {
    title: 'Contrato de locação residencial',
    summary:
      'Contrato de aluguel de um apartamento residencial. Estabelece aluguel mensal de R$ 3.200 mais condomínio e IPTU, vencimento no dia 5, multa por atraso e as obrigações de locador e locatário.',
  },
  {
    title: 'Manual cafeteira Brava',
    summary:
      'Manual de instruções da máquina de café espresso Brava. Explica o primeiro uso, o ajuste do moedor integrado, como vaporizar leite, a limpeza diária e a descalcificação. Lista os códigos de erro do visor (E04, E07) com as soluções e as condições da garantia de 12 meses, estendida para 24 com cadastro.',
  },
  {
    title: 'Manual moedor Brava M2',
    summary:
      'Manual do moedor de café avulso Brava M2. Traz a garantia de 6 meses, o que ela não cobre (mós são peças de desgaste) e como acionar a assistência técnica.',
  },
  {
    title: 'Caderno de receitas',
    summary:
      'Caderno de receitas caseiras da família: bolo de cenoura com cobertura de chocolate, bolo de fubá cremoso, pão de queijo mineiro, moqueca capixaba e moqueca baiana de camarão, risoto de cogumelos e brigadeiro. Inclui dicas de conservação de alimentos cozidos na geladeira e no congelador.',
  },
  {
    title: 'Relatório financeiro 2T26',
    summary:
      'Relatório de resultados do segundo trimestre de 2026. Apresenta receita líquida de R$ 14,3 milhões, queda do fluxo de caixa operacional por aumento do prazo de recebimento e a alta da inadimplência na carteira, concentrada no varejo, com as ações de cobrança adotadas.',
  },
  {
    title: 'Manual de lançamentos contábeis',
    summary:
      'Manual de lançamentos contábeis do financeiro. Define os centros de custo por área (CC-110 a CC-900) e o rateio de despesas compartilhadas, e o prazo para lançar notas fiscais de fornecedores no ERP antes do fechamento do mês.',
  },
  {
    title: 'Política de compras',
    summary:
      'Política de compras da empresa. Define as alçadas de aprovação por valor (gestor, diretor, CFO), a exigência de três cotações acima de R$ 50 mil e as regras de uso e conciliação do cartão corporativo.',
  },
  {
    title: 'Política de tesouraria',
    summary:
      'Política de tesouraria sobre a aplicação da reserva de caixa. Exige caixa mínimo de três meses de despesas fixas, aplicado em CDB de liquidez diária de bancos de primeira linha, e define os limites para aplicações de prazo maior.',
  },
  {
    title: 'Política de pessoas',
    summary:
      'Política de pessoas com as regras para colaboradores: férias e sua divisão em períodos, trabalho híbrido com ajuda de custo, licença-maternidade e paternidade, plano de saúde e coparticipação, ciclo de avaliação de desempenho, controle de ponto com banco de horas e o processo de desligamento.',
  },
  {
    title: 'Código de conduta',
    summary:
      'Código de conduta ética da empresa. Trata de conflitos de interesse, relacionamento com fornecedores e clientes e das regras para aceitar brindes e presentes, com limite de valor e o que fazer quando é preciso recusar.',
  },
  {
    title: 'Comunicado de férias coletivas',
    summary:
      'Comunicado do RH sobre as férias coletivas de fim de ano, de 22 de dezembro a 2 de janeiro, com as exceções das equipes de suporte e plantão e o desconto dos dias no saldo individual de férias.',
  },
  {
    title: 'Política de viagens (vigente desde 2025)',
    summary:
      'Política de viagens a trabalho em vigor desde 2025. Exige aprovação do gestor no app Despesas antes da compra de passagens, com antecedência mínima, e define as diárias de alimentação, os limites de hospedagem por cidade e o prazo para pedir reembolso com comprovantes.',
  },
  {
    title: 'Política de viagens de 2023 (revogada)',
    summary:
      'Versão de 2023 da política de viagens, já revogada e mantida só para consulta histórica. Trazia diária de alimentação de R$ 70, hospedagem até R$ 300 e entrega de comprovantes em papel.',
  },
  {
    title: 'Runbook de deploy',
    summary:
      'Runbook de deploy da API. Descreve o pipeline do GitHub Actions, a publicação automática em staging a partir da develop, a promoção para produção com aprovação manual e janela de horário, e como fazer rollback de uma versão com problema.',
  },
  {
    title: 'Guia de operações',
    summary:
      'Guia de operações da infraestrutura de produção. Cobre o backup do PostgreSQL (snapshots, WAL, RPO e RTO), o backup dos arquivos enviados pelos clientes no S3 e a configuração de variáveis de ambiente e segredos no Vault.',
  },
  {
    title: 'Guia de troubleshooting',
    summary:
      'Guia de diagnóstico de problemas da API em produção no Kubernetes, como respostas 502 Bad Gateway causadas por pods reiniciando por falta de memória (OOMKilled), com os comandos para investigar e corrigir.',
  },
  {
    title: 'Processo de incidentes',
    summary:
      'Processo de gestão de incidentes que afetam clientes: abertura de canal no Slack, acionamento do plantão pelo PagerDuty, papel do comandante do incidente, comunicação com clientes e o post-mortem.',
  },
  {
    title: 'Documentação da API pública',
    summary:
      'Documentação da API pública v2 para integradores. Explica a autenticação OAuth 2.0 com client credentials, a validade do token e os limites de requisições com o código 429.',
  },
  {
    title: 'Documentação da API v1 (descontinuada)',
    summary:
      'Documentação da versão 1 da API, descontinuada em janeiro de 2026. A v1 autenticava por chave fixa na URL (api_key) e não tinha limite de requisições; o documento orienta a migração para a v2 e informa a data de desligamento.',
  },
  {
    title: 'README do repositório da API',
    summary:
      'README do repositório da API com o passo a passo para montar o ambiente de desenvolvimento: Node 24, pnpm, arquivo .env, Postgres e Redis no docker compose, migrações e testes.',
  },
]

type ChatKind = 'none' | 'near' | 'direct' | 'indirect' | 'english'

export interface ChatMessage {
  text: string
  kind: ChatKind
  /** Documents a suggestion should bring up (recall counts these). */
  expected: string[]
  /** Also fine to suggest (not a false alarm, not required). */
  acceptable?: string[]
}

const none = (text: string): ChatMessage => ({ text, kind: 'none', expected: [] })

export const CHAT: ChatMessage[] = [
  // Not about any document: the suggestion must stay silent.
  none('oi'),
  none('bom dia!'),
  none('Oi, tudo bem?'),
  none('obrigado, valeu!'),
  none('ok, pode fazer'),
  none('pode continuar'),
  none('perfeito, era isso mesmo 👍'),
  none('cria um bot de vendas pra mim'),
  none('Cria um bot chamado Luna para cuidar do marketing e das redes sociais'),
  none('cria um grupo com o Pedro e a Ana pra gente discutir o lançamento'),
  none('manda um oi pro bot de marketing'),
  none('escreve uma função em Python que ordena uma lista de dicionários pela chave "data"'),
  none('revisa esse PR e roda os testes antes de aprovar'),
  none('instala o docker na VM e sobe um nginx de teste'),
  none('lista os arquivos do repositório milibot'),
  none('qual a capital da Austrália?'),
  none('me explica o que é machine learning de um jeito simples'),
  none('quanto é 15% de 230?'),
  none('traduz "good morning, how are you?" pro espanhol'),
  none('qual a previsão do tempo em São Paulo amanhã?'),
  none('abre o navegador e pesquisa a cotação do dólar hoje'),
  none('cria uma rotina todo dia às 8h pra me mandar as principais notícias'),
  none('me ajuda a escrever uma mensagem de aniversário pra minha mãe'),
  none('gera umas ideias de nome para a minha loja de roupas'),
  none('faz um resumo do que a gente conversou hoje'),
  none('quem ganhou a Copa do Mundo de 2002?'),
  none('thanks, that was helpful'),
  none('hi there'),
  none('Can you write a SQL query that counts orders per customer?'),
  // Near a document's topic but not a question about it: acceptable either way, other docs are false alarms.
  {
    text: 'me passa uma receita de bolo de chocolate simples',
    kind: 'near',
    expected: [],
    acceptable: ['Caderno de receitas'],
  },
  {
    text: 'escreve um script bash que faz backup da minha pasta de fotos todo domingo',
    kind: 'near',
    expected: [],
    acceptable: ['Guia de operações'],
  },
  {
    text: 'o deploy do meu site pessoal na Vercel está falhando, olha o log pra mim',
    kind: 'near',
    expected: [],
    acceptable: ['Runbook de deploy', 'Guia de troubleshooting'],
  },
  {
    text: 'qual café você recomenda para fazer na prensa francesa?',
    kind: 'near',
    expected: [],
    acceptable: ['Manual cafeteira Brava', 'Manual moedor Brava M2'],
  },
  // About a document, asked directly.
  {
    text: 'O que diz a cláusula de rescisão do contrato com a Beta?',
    kind: 'direct',
    expected: ['Contrato de serviços Alfa × Beta'],
  },
  {
    text: 'a cafeteira está mostrando erro E07 no visor',
    kind: 'direct',
    expected: ['Manual cafeteira Brava'],
  },
  {
    text: 'qual é a receita do pão de queijo?',
    kind: 'direct',
    expected: ['Caderno de receitas'],
  },
  {
    text: 'como faço rollback da API em produção?',
    kind: 'direct',
    expected: ['Runbook de deploy'],
    acceptable: ['Guia de troubleshooting', 'Processo de incidentes'],
  },
  {
    text: 'quantos dias de licença-paternidade a empresa dá?',
    kind: 'direct',
    expected: ['Política de pessoas'],
  },
  {
    text: 'qual foi a receita líquida do segundo trimestre?',
    kind: 'direct',
    expected: ['Relatório financeiro 2T26'],
  },
  {
    text: 'Oi! Amanhã tenho reunião com a Beta Logística e queria entender quanto a gente cobra por mês e como funciona o reajuste',
    kind: 'direct',
    expected: ['Contrato de serviços Alfa × Beta'],
  },
  {
    text: 'qual o centro de custo de Tecnologia?',
    kind: 'direct',
    expected: ['Manual de lançamentos contábeis'],
  },
  // About a document, phrased indirectly (no title words).
  {
    text: 'minha máquina de café tá apitando e não sai água nenhuma',
    kind: 'indirect',
    expected: ['Manual cafeteira Brava'],
  },
  {
    text: 'vou pra Recife a trabalho semana que vem, o que preciso fazer antes de comprar a passagem?',
    kind: 'indirect',
    expected: ['Política de viagens (vigente desde 2025)'],
    acceptable: ['Política de viagens de 2023 (revogada)'],
  },
  {
    text: 'a Beta atrasou o pagamento de novo, dá pra cobrar alguma coisa deles?',
    kind: 'indirect',
    expected: ['Contrato de serviços Alfa × Beta'],
  },
  {
    text: 'o site tá voltando erro 502 desde cedo',
    kind: 'indirect',
    expected: ['Guia de troubleshooting'],
    acceptable: ['Processo de incidentes', 'Runbook de deploy'],
  },
  {
    text: 'meu filho nasceu ontem! quanto tempo posso ficar em casa com ele?',
    kind: 'indirect',
    expected: ['Política de pessoas'],
  },
  {
    text: 'quero fazer um lanche mineiro pro café da tarde de sábado, como faço?',
    kind: 'indirect',
    expected: ['Caderno de receitas'],
  },
  {
    text: 'comprei um notebook de R$ 7 mil pro time, quem precisa aprovar isso?',
    kind: 'indirect',
    expected: ['Política de compras'],
  },
  {
    text: 'o dinheiro que entrou no caixa caiu nesses últimos meses? por quê?',
    kind: 'indirect',
    expected: ['Relatório financeiro 2T26'],
  },
  {
    text: 'onde fica guardada a senha do banco de produção?',
    kind: 'indirect',
    expected: ['Guia de operações'],
  },
  {
    text: 'tô começando no time amanhã, como eu rodo a API na minha máquina?',
    kind: 'indirect',
    expected: ['README do repositório da API'],
  },
  {
    text: 'um fornecedor quer me dar um vinho caro de presente, posso aceitar?',
    kind: 'indirect',
    expected: ['Código de conduta'],
  },
  {
    text: 'vou sair da empresa na sexta, o que eu tenho que devolver?',
    kind: 'indirect',
    expected: ['Política de pessoas'],
  },
  {
    text: 'se eu pagar o aluguel do apartamento no dia 8 o proprietário pode me cobrar multa?',
    kind: 'indirect',
    expected: ['Contrato de locação residencial'],
  },
  {
    text: 'o moedor avulso parou de funcionar depois de 8 meses, ainda tá coberto?',
    kind: 'indirect',
    expected: ['Manual moedor Brava M2'],
    acceptable: ['Manual cafeteira Brava'],
  },
  {
    text: 'um cliente ainda manda api_key na URL, até quando isso vai funcionar?',
    kind: 'indirect',
    expected: ['Documentação da API v1 (descontinuada)'],
    acceptable: ['Documentação da API pública'],
  },
  {
    text: 'vai ter recesso no fim do ano?',
    kind: 'indirect',
    expected: ['Comunicado de férias coletivas'],
    acceptable: ['Política de pessoas'],
  },
  {
    text: 'em que conta eu lanço a fatura de energia do escritório?',
    kind: 'indirect',
    expected: ['Manual de lançamentos contábeis'],
  },
  {
    text: 'a gente pode deixar o dinheiro parado num fundo de 2 anos?',
    kind: 'indirect',
    expected: ['Política de tesouraria'],
  },
  {
    text: 'caiu tudo pra vários clientes agora, quem puxa a resposta?',
    kind: 'indirect',
    expected: ['Processo de incidentes'],
    acceptable: ['Guia de troubleshooting'],
  },
  // English messages about a document.
  {
    text: 'What is the notice period to terminate the Beta contract?',
    kind: 'english',
    expected: ['Contrato de serviços Alfa × Beta'],
  },
  {
    text: 'how do I ship a new version to production?',
    kind: 'english',
    expected: ['Runbook de deploy'],
  },
  {
    text: 'the espresso machine shows E04, what should I do?',
    kind: 'english',
    expected: ['Manual cafeteira Brava'],
  },
  {
    text: 'how long does an API access token last?',
    kind: 'english',
    expected: ['Documentação da API pública'],
    acceptable: ['Documentação da API v1 (descontinuada)'],
  },
]

/** Every chat label names a document of the corpus. */
export function checkRelevanceData(): void {
  const titles = new Set(DOCS.map((d) => d.title))
  const corpusDocs = new Set(PASSAGES.map((p) => p.doc))
  for (const t of corpusDocs) if (!titles.has(t)) throw new Error(`no summary for ${t}`)
  for (const m of CHAT)
    for (const t of [...m.expected, ...(m.acceptable ?? [])])
      if (!titles.has(t)) throw new Error(`unknown document ${t} in "${m.text}"`)
}
