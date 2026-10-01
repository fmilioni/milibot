/**
 * Small pt-BR knowledge base for the embedding eval: passages of the size of a short chunk from six
 * kinds of documents, with near-duplicates and distractors (another contract's payment clause, the
 * revoked travel policy, the other error code, staging vs production deploy, the other moqueca, the
 * grinder's warranty, API v1). Questions: pt-BR paraphrases, exact terms, answers spread over several
 * passages, and English questions (bots often search in English).
 *
 * Portuguese on purpose: the eval measures retrieval over pt-BR documents.
 */

export interface Passage {
  id: string
  doc: string
  text: string
}

export type QueryKind = 'paraphrase' | 'exact' | 'spread' | 'crosslingual'

export interface EvalQuery {
  query: string
  kind: QueryKind
  /** Every passage that answers it (spread questions have several). */
  expected: string[]
}

export const PASSAGES: Passage[] = [
  // Service agreement (Alfa Sistemas × Beta Logística)
  {
    id: 'c-pagamento',
    doc: 'Contrato de serviços Alfa × Beta',
    text: 'Cláusula 5ª – Do pagamento. A CONTRATANTE pagará à CONTRATADA o valor mensal de R$ 18.500,00 (dezoito mil e quinhentos reais) até o décimo dia útil do mês subsequente ao da prestação dos serviços, mediante boleto bancário emitido com antecedência mínima de cinco dias. O atraso sujeitará a CONTRATANTE à multa moratória de 2% sobre o valor devido e a juros de mora de 1% ao mês, calculados pro rata die, além de correção monetária.',
  },
  {
    id: 'c-reajuste',
    doc: 'Contrato de serviços Alfa × Beta',
    text: 'Cláusula 6ª – Do reajuste. O valor mensal será reajustado a cada período de 12 (doze) meses, contados da data de assinatura, pela variação acumulada do IPCA/IBGE no período. Na hipótese de extinção do índice ou de sua variação ser negativa, as partes adotarão o INPC ou manterão o valor vigente, respectivamente, sem necessidade de aditivo contratual.',
  },
  {
    id: 'c-rescisao',
    doc: 'Contrato de serviços Alfa × Beta',
    text: 'Cláusula 11ª – Da rescisão. Qualquer das partes poderá rescindir este contrato imotivadamente, a qualquer tempo, mediante aviso prévio por escrito com antecedência mínima de 60 (sessenta) dias. A rescisão motivada por descumprimento de obrigação contratual, não sanado em 15 dias após notificação, sujeitará a parte infratora ao pagamento de multa compensatória equivalente a três mensalidades vigentes.',
  },
  {
    id: 'c-confidencialidade',
    doc: 'Contrato de serviços Alfa × Beta',
    text: 'Cláusula 9ª – Da confidencialidade. As partes obrigam-se a manter sob sigilo todas as informações técnicas, comerciais e financeiras a que tiverem acesso em razão deste contrato, não as divulgando a terceiros sem autorização por escrito. Esta obrigação permanece válida durante a vigência e por 5 (cinco) anos após o término da relação contratual, qualquer que seja o motivo do encerramento.',
  },
  {
    id: 'c-foro',
    doc: 'Contrato de serviços Alfa × Beta',
    text: 'Cláusula 14ª – Do foro. Fica eleito o foro da Comarca de Campinas, Estado de São Paulo, para dirimir quaisquer controvérsias oriundas deste instrumento, com renúncia expressa a qualquer outro, por mais privilegiado que seja. As partes se comprometem a buscar solução amigável por mediação antes de recorrer ao Judiciário.',
  },
  {
    id: 'c-sla',
    doc: 'Contrato de serviços Alfa × Beta',
    text: 'Anexo II – Níveis de serviço. Chamados de severidade 1 (sistema totalmente indisponível) terão primeira resposta em até 30 minutos e solução de contorno em até 4 horas, 24x7. Severidade 2 (funcionalidade crítica degradada): resposta em 2 horas úteis. O descumprimento dos prazos gera desconto de 5% na fatura do mês por ocorrência, limitado a 20% do valor mensal.',
  },
  {
    id: 'c-lgpd',
    doc: 'Contrato de serviços Alfa × Beta',
    text: 'Cláusula 10ª – Da proteção de dados. A CONTRATADA atuará como operadora dos dados pessoais tratados em nome da CONTRATANTE, nos termos da Lei nº 13.709/2018, seguindo exclusivamente as instruções documentadas desta. Incidentes de segurança que envolvam dados pessoais deverão ser comunicados em até 24 horas, e os dados serão eliminados ou devolvidos ao fim do contrato.',
  },
  {
    id: 'c-locacao-pagamento',
    doc: 'Contrato de locação residencial',
    text: 'Cláusula 3ª – Do aluguel. O LOCATÁRIO pagará mensalmente o aluguel de R$ 3.200,00, acrescido de condomínio e IPTU, até o dia 5 (cinco) de cada mês, por transferência para a conta indicada pelo LOCADOR. O pagamento após o vencimento acarretará multa de 10% sobre o valor do aluguel, juros de 1% ao mês e correção pelo IGP-M.',
  },

  // Brava 20 bar espresso machine manual
  {
    id: 'm-descalcificacao',
    doc: 'Manual cafeteira Brava',
    text: 'Descalcificação. Quando o indicador de manutenção piscar em laranja, dilua 100 ml de solução descalcificante em 500 ml de água no reservatório, coloque um recipiente de 1 litro sob o grupo e o bico de vapor e mantenha pressionado o botão de limpeza por 5 segundos. O ciclo leva cerca de 20 minutos. Repita o processo a cada 3 meses ou 200 extrações, ou com mais frequência se a água da sua região for dura.',
  },
  {
    id: 'm-erro-e04',
    doc: 'Manual cafeteira Brava',
    text: 'Código de erro E04 – Falha no sensor de temperatura da caldeira. A máquina interrompe o aquecimento por segurança. Desligue o aparelho da tomada, aguarde 10 minutos para o resfriamento e ligue novamente. Se a mensagem persistir, procure uma assistência técnica autorizada. Não tente abrir o aparelho: a violação do lacre cancela a garantia.',
  },
  {
    id: 'm-erro-e07',
    doc: 'Manual cafeteira Brava',
    text: 'Código de erro E07 – Reservatório de água vazio ou mal encaixado. Retire o reservatório, complete com água filtrada até a marca MAX e encaixe-o até ouvir um clique. Verifique se a boia magnética no fundo do reservatório se move livremente; resíduos de calcário podem travá-la e gerar o aviso mesmo com o reservatório cheio.',
  },
  {
    id: 'm-moagem',
    doc: 'Manual cafeteira Brava',
    text: 'Ajuste da moagem. O moedor integrado tem 12 posições, de 1 (mais fina) a 12 (mais grossa). Se o café sair rápido demais, aguado e com pouca crema, gire o seletor para uma moagem mais fina; se sair em gotas e amargo, use uma moagem mais grossa. Altere apenas com o moedor em funcionamento e uma posição por vez, avaliando o resultado na extração seguinte.',
  },
  {
    id: 'm-vapor',
    doc: 'Manual cafeteira Brava',
    text: 'Bico de vapor. Para vaporizar leite, use uma jarra de inox com leite gelado até um terço da altura. Antes de começar, abra o vapor por 2 segundos para eliminar a água condensada. Posicione a ponta logo abaixo da superfície para incorporar ar e depois mergulhe-a para aquecer até 65 °C. Ao terminar, limpe o bico com pano úmido e purgue novamente para evitar leite ressecado na saída.',
  },
  {
    id: 'm-garantia',
    doc: 'Manual cafeteira Brava',
    text: 'Garantia. A cafeteira Brava tem garantia de 12 meses contra defeitos de fabricação, contados da data da nota fiscal. A garantia é estendida para 24 meses mediante cadastro do produto no site do fabricante em até 30 dias após a compra. Não estão cobertos danos causados por acúmulo de calcário, quedas, uso de tensão elétrica incorreta ou reparos feitos fora da rede autorizada.',
  },
  {
    id: 'm-primeiro-uso',
    doc: 'Manual cafeteira Brava',
    text: 'Primeiro uso. Retire todos os adesivos e lave o reservatório e o porta-filtro com água e detergente neutro. Encha o reservatório até a marca MAX, ligue a máquina e aguarde o aquecimento. Faça dois ciclos completos apenas com água quente, sem café, e descarte a água: isso elimina resíduos do processo de fabricação e ceva o circuito hidráulico.',
  },
  {
    id: 'm-limpeza-diaria',
    doc: 'Manual cafeteira Brava',
    text: 'Limpeza diária. Esvazie a gaveta de borra e a bandeja de gotejamento ao fim do dia e lave-as com água morna. Enxágue o porta-filtro e passe um pano no grupo de extração para remover pó de café. Uma vez por semana, retire o chuveiro do grupo com a chave fornecida e deixe-o de molho em água quente. Nunca coloque peças plásticas na lava-louças.',
  },

  // Recipes
  {
    id: 'r-bolo-cenoura',
    doc: 'Caderno de receitas',
    text: 'Bolo de cenoura com cobertura de chocolate. Bata no liquidificador 3 cenouras médias, 4 ovos e 1 xícara de óleo. Em uma tigela, misture 2 xícaras de açúcar e 2 e meia de farinha de trigo, junte o creme e por último 1 colher de sopa de fermento. Asse em forma untada a 180 °C por 40 minutos. Para a cobertura, ferva 1 colher de manteiga, 3 de chocolate em pó, 1 xícara de açúcar e meia de leite até engrossar.',
  },
  {
    id: 'r-pao-queijo',
    doc: 'Caderno de receitas',
    text: 'Pão de queijo mineiro. Ferva 1 xícara de leite, meia de óleo e 1 colher de chá de sal e escalde 500 g de polvilho azedo (o doce deixa o pão mais denso e menos crocante). Espere amornar, acrescente 2 ovos e 250 g de queijo meia-cura ralado e sove até a massa desgrudar das mãos. Faça bolinhas com as mãos untadas e asse a 200 °C por 25 minutos, até dourar. A massa crua pode ser congelada.',
  },
  {
    id: 'r-moqueca',
    doc: 'Caderno de receitas',
    text: 'Moqueca capixaba. Na panela de barro, faça camadas de cebola, tomate e coentro, disponha as postas de robalo temperadas com limão e sal e cubra com mais uma camada de legumes. Regue com azeite e urucum para dar cor, tampe e cozinhe em fogo baixo por 20 minutos sem mexer, só balançando a panela. Diferente da versão baiana, não leva azeite de dendê nem leite de coco. Sirva com pirão e arroz branco.',
  },
  {
    id: 'r-moqueca-baiana',
    doc: 'Caderno de receitas',
    text: 'Moqueca baiana de camarão. Refogue cebola, alho e pimentões coloridos no azeite de dendê, junte os tomates e os camarões limpos e cozinhe por 5 minutos. Acrescente 200 ml de leite de coco, ajuste o sal e finalize com coentro picado. O dendê e o leite de coco são o que diferenciam a receita da Bahia. Acompanha farofa de dendê e arroz.',
  },
  {
    id: 'r-risoto',
    doc: 'Caderno de receitas',
    text: 'Risoto de cogumelos. Refogue a cebola na manteiga, junte 1 xícara de arroz arbóreo e mexa até os grãos ficarem translúcidos. Adicione meio copo de vinho branco e, depois que evaporar, acrescente o caldo quente de concha em concha, mexendo sempre e só colocando mais quando o anterior for absorvido. É isso que libera o amido e deixa o prato cremoso. No fim, desligue o fogo e incorpore manteiga gelada e parmesão.',
  },
  {
    id: 'r-conservacao',
    doc: 'Caderno de receitas',
    text: 'Conservação de alimentos cozidos. Feijão pronto dura até 3 dias na geladeira, em pote fechado, e até 3 meses no congelador, separado em porções. Arroz cozido deve ser consumido em até 2 dias. Espere a comida amornar antes de refrigerar, mas não deixe fora da geladeira por mais de 2 horas. Descongele na geladeira de um dia para o outro, nunca na bancada.',
  },
  {
    id: 'r-brigadeiro',
    doc: 'Caderno de receitas',
    text: 'Brigadeiro de festa. Em panela antiaderente, misture 1 lata de leite condensado, 1 colher de sopa de manteiga e 4 colheres de sopa de chocolate em pó 50%. Mexa em fogo baixo até a massa desgrudar do fundo da panela, cerca de 10 minutos. Deixe esfriar completamente antes de enrolar com as mãos untadas e passe no granulado.',
  },

  // Finance
  {
    id: 'f-fluxo-caixa',
    doc: 'Relatório financeiro 2T26',
    text: 'Resultado do 2º trimestre de 2026. A receita líquida somou R$ 14,3 milhões, alta de 6% sobre o trimestre anterior, mas o fluxo de caixa operacional ficou em R$ 1,2 milhão, queda de 8%, por causa do aumento do prazo médio de recebimento para 52 dias. O EBITDA ajustado foi de R$ 2,9 milhões, com margem de 20,3%.',
  },
  {
    id: 'f-inadimplencia',
    doc: 'Relatório financeiro 2T26',
    text: 'Inadimplência. A parcela de títulos vencidos há mais de 30 dias subiu de 3,1% para 4,7% da carteira entre março e junho, puxada principalmente pelo segmento de varejo, que concentra 60% dos atrasos. O time de cobrança passou a oferecer parcelamento em até 6 vezes e a provisão para devedores duvidosos foi ampliada em R$ 180 mil.',
  },
  {
    id: 'f-centro-custo',
    doc: 'Manual de lançamentos contábeis',
    text: 'Centros de custo. Todo lançamento de despesa precisa ter centro de custo. Use CC-110 para Administrativo, CC-210 para Comercial, CC-310 para Tecnologia e CC-410 para Operações. Despesas compartilhadas, como aluguel e energia, vão para CC-900 e são rateadas no fechamento pelo número de funcionários de cada área.',
  },
  {
    id: 'f-aprovacao-compras',
    doc: 'Política de compras',
    text: 'Alçadas de aprovação. Compras de até R$ 5.000 são aprovadas pelo gestor imediato. De R$ 5.000,01 a R$ 50.000, pelo diretor da área. Acima de R$ 50.000, a aprovação é do CFO e exige ao menos três cotações de fornecedores diferentes, anexadas ao pedido no ERP. Fracionar uma compra para ficar abaixo de uma alçada é proibido.',
  },
  {
    id: 'f-nota-fiscal',
    doc: 'Manual de lançamentos contábeis',
    text: 'Notas fiscais de fornecedores. As notas devem ser lançadas no ERP até o dia 25 de cada mês para entrar no fechamento corrente. Notas recebidas após essa data são contabilizadas no mês seguinte, e o pagamento segue o vencimento original. O fornecedor deve enviar o XML para notas@empresa.com.br; PDF sozinho não é aceito.',
  },
  {
    id: 'f-investimento',
    doc: 'Política de tesouraria',
    text: 'Aplicações financeiras. A reserva de caixa é aplicada em CDB de bancos de primeira linha com liquidez diária, remunerado a no mínimo 102% do CDI. A política exige manter um caixa mínimo equivalente a três meses de despesas fixas; o excedente pode ir para LCI e LCA com vencimento de até 12 meses, respeitado o limite de 30% por instituição.',
  },

  // HR
  {
    id: 'h-ferias',
    doc: 'Política de pessoas',
    text: 'Férias. Cada colaborador tem direito a 30 dias de férias por ano trabalhado, que podem ser divididos em até três períodos, sendo um deles de no mínimo 14 dias corridos e os demais de pelo menos 5 dias. A solicitação deve ser feita pelo portal do colaborador com 30 dias de antecedência e aprovada pelo gestor. Não é permitido iniciar férias nos dois dias que antecedem feriado ou descanso semanal.',
  },
  {
    id: 'h-home-office',
    doc: 'Política de pessoas',
    text: 'Trabalho remoto. As equipes podem trabalhar de casa até 3 dias por semana, combinando com o gestor os dias presenciais do time. Quem adere ao modelo híbrido recebe ajuda de custo de R$ 150 por mês, paga na folha, para cobrir internet e energia elétrica, além de cadeira e monitor emprestados mediante termo de responsabilidade.',
  },
  {
    id: 'h-reembolso',
    doc: 'Política de viagens (vigente desde 2025)',
    text: 'Reembolso de despesas de viagem. Envie os comprovantes pelo app Despesas em até 10 dias após o retorno. A diária de alimentação no Brasil é de R$ 90; a hospedagem é reembolsada até R$ 400 por noite em capitais e R$ 280 nas demais cidades. Táxi e aplicativo são reembolsados para deslocamentos a trabalho; bebidas alcoólicas não são reembolsáveis.',
  },
  {
    id: 'h-reembolso-antigo',
    doc: 'Política de viagens de 2023 (revogada)',
    text: 'Política de viagens de 2023, revogada. A diária de alimentação era de R$ 70 e a hospedagem era reembolsada até R$ 300 por noite em qualquer cidade. Os comprovantes eram entregues em papel ao financeiro em até 30 dias. Este documento é mantido apenas para consulta histórica.',
  },
  {
    id: 'h-licenca-parental',
    doc: 'Política de pessoas',
    text: 'Licenças parentais. A empresa participa do programa Empresa Cidadã: a licença-maternidade é de 180 dias e a licença-paternidade de 20 dias corridos, contados do nascimento ou da adoção. Na volta, mães e pais podem trabalhar em jornada reduzida de 6 horas por 30 dias sem redução de salário.',
  },
  {
    id: 'h-plano-saude',
    doc: 'Política de pessoas',
    text: 'Plano de saúde. O plano é nacional, com acomodação em apartamento, e cobre titular, cônjuge e filhos até 24 anos sem custo de mensalidade. Há coparticipação de 20% em consultas e exames simples, limitada a R$ 60 por procedimento e R$ 300 por mês, descontada em folha. Internações e cirurgias não têm coparticipação.',
  },
  {
    id: 'h-avaliacao',
    doc: 'Política de pessoas',
    text: 'Avaliação de desempenho. O ciclo é semestral, com fechamento em março e setembro. Cada pessoa faz uma autoavaliação, recebe a avaliação do gestor e de dois pares, e o resultado passa por uma calibração entre os líderes da área. A nota final define a elegibilidade a promoções e o multiplicador da participação nos lucros.',
  },
  {
    id: 'h-codigo-conduta',
    doc: 'Código de conduta',
    text: 'Brindes e presentes. Colaboradores podem aceitar brindes institucionais e presentes de fornecedores, clientes ou parceiros de valor estimado até R$ 100, uma vez por ano por empresa. Qualquer presente acima desse valor deve ser recusado com educação ou entregue ao Compliance, que decidirá sobre doação. Convites para viagens e hospedagem pagas por fornecedores são proibidos.',
  },
  {
    id: 'h-desligamento',
    doc: 'Política de pessoas',
    text: 'Desligamento. No último dia de trabalho, o colaborador deve devolver notebook, crachá, cartão corporativo e demais equipamentos ao time de Facilities, que emite o termo de devolução. Os acessos a sistemas são revogados às 18h do mesmo dia. As verbas rescisórias são pagas em até 10 dias e a entrevista de saída é agendada pelo RH.',
  },
  {
    id: 'h-ponto',
    doc: 'Política de pessoas',
    text: 'Controle de jornada. O registro de ponto é feito pelo app Ponto, na entrada, na saída e nos intervalos. O saldo positivo vai para o banco de horas e deve ser compensado em até 6 meses; o que não for compensado é pago como hora extra. Horas extras só podem ser feitas com aprovação prévia do gestor no próprio app.',
  },

  // Technical documentation
  {
    id: 't-deploy',
    doc: 'Runbook de deploy',
    text: 'Deploy em produção. O merge na branch main dispara o pipeline no GitHub Actions, que roda testes, gera a imagem e publica em staging. A promoção para produção exige aprovação manual no job promote por alguém do time de plataforma. A janela de deploy em produção é de segunda a quinta, das 10h às 16h; às sextas-feiras, vésperas de feriado e fora do horário, só correções emergenciais aprovadas pelo líder técnico.',
  },
  {
    id: 't-deploy-staging',
    doc: 'Runbook de deploy',
    text: 'Deploy em homologação (staging). Todo merge na branch develop publica automaticamente no ambiente de staging, sem aprovação e sem janela de horário. O banco de staging é recriado toda segunda-feira a partir de um dump anonimizado de produção. Use staging para testes de integração e validação com o time de produto.',
  },
  {
    id: 't-rollback',
    doc: 'Runbook de deploy',
    text: 'Rollback. Se uma versão nova causar erros em produção, execute kubectl rollout undo deployment/api -n prod para voltar à revisão anterior, ou reexecute o job promote informando a tag da última versão estável. Migrações de banco não são revertidas automaticamente: confira no PR se a migração é compatível com a versão anterior antes de voltar.',
  },
  {
    id: 't-erro-502',
    doc: 'Guia de troubleshooting',
    text: 'Erros 502 no gateway. Respostas 502 Bad Gateway costumam indicar que os pods da API estão reiniciando, quase sempre por OOMKilled. Rode kubectl describe pod no namespace prod e procure por Last State: Terminated, Reason: OOMKilled. A correção é aumentar resources.limits.memory no values.yaml do chart ou investigar vazamento de memória no último deploy.',
  },
  {
    id: 't-api-auth',
    doc: 'Documentação da API pública',
    text: 'Autenticação da API. A API pública usa OAuth 2.0 no fluxo client credentials: troque client_id e client_secret por um token em POST /oauth/token. O token expira em 3600 segundos e deve ser enviado no header Authorization: Bearer. O limite é de 600 requisições por minuto por cliente; acima disso a API responde HTTP 429 com o header Retry-After indicando quantos segundos esperar.',
  },
  {
    id: 't-backup-db',
    doc: 'Guia de operações',
    text: 'Backup do PostgreSQL. O banco de produção tem snapshot diário às 03:00 UTC, com retenção de 35 dias, além de arquivamento contínuo do WAL. O objetivo de ponto de recuperação (RPO) é de 15 minutos e o de tempo de recuperação (RTO) é de 4 horas. Um teste de restauração completa é feito todo mês em ambiente isolado e registrado no Confluence.',
  },
  {
    id: 't-variaveis',
    doc: 'Guia de operações',
    text: 'Configuração e segredos. A API lê DATABASE_URL, REDIS_URL e FEATURE_FLAGS_KEY do ambiente. Em produção, os valores ficam no Vault, no caminho secret/data/api/prod, e são injetados pelo sidecar do agente do Vault. Nunca commite arquivos .env; o repositório tem um .env.example com valores falsos para desenvolvimento.',
  },
  {
    id: 't-onboarding-dev',
    doc: 'README do repositório da API',
    text: 'Ambiente de desenvolvimento. Instale Node 24 e pnpm, clone o repositório e rode pnpm install. Copie .env.example para .env e suba Postgres e Redis com docker compose up -d. As migrações rodam com pnpm db:migrate e os testes com pnpm test. A API local responde em http://localhost:3000 e a documentação interativa em /docs.',
  },
  {
    id: 't-incidente',
    doc: 'Processo de incidentes',
    text: 'Gestão de incidentes. Quem detectar uma indisponibilidade que afete clientes abre um canal #inc-AAAAMMDD no Slack e aciona o plantão pelo PagerDuty. A primeira pessoa sênior a entrar assume o papel de comandante do incidente, que coordena a investigação e a comunicação com o suporte. Depois da resolução, o time escreve um postmortem sem culpados em até 5 dias úteis.',
  },

  // Distractors: same vocabulary, different facts
  {
    id: 'm-garantia-moedor',
    doc: 'Manual moedor Brava M2',
    text: 'Garantia do moedor Brava M2. O moedor avulso tem garantia de 6 meses contra defeitos de fabricação, sem extensão por cadastro. As mós são peças de desgaste e não são cobertas; recomenda-se trocá-las a cada 250 kg de café moído. Para acionar a garantia, apresente a nota fiscal em uma assistência autorizada.',
  },
  {
    id: 't-api-auth-v1',
    doc: 'Documentação da API v1 (descontinuada)',
    text: 'API v1 (descontinuada em janeiro de 2026). A versão antiga autenticava por chave fixa no parâmetro api_key da URL, sem expiração, e não tinha limite de requisições. Clientes que ainda usam a v1 devem migrar para a v2, que usa OAuth; a v1 será desligada em dezembro de 2026.',
  },
  {
    id: 'h-ferias-coletivas',
    doc: 'Comunicado de férias coletivas',
    text: 'Férias coletivas de fim de ano. A empresa concederá férias coletivas de 22 de dezembro a 2 de janeiro para todas as áreas, exceto suporte e plantão de infraestrutura, que terão escala própria. Esses dias são descontados do saldo individual de férias de cada colaborador.',
  },
  {
    id: 'f-aprovacao-viagens',
    doc: 'Política de viagens (vigente desde 2025)',
    text: 'Aprovação de viagens. Toda viagem a trabalho precisa ser aprovada pelo gestor no app Despesas antes da compra das passagens, com pelo menos 7 dias de antecedência para voos nacionais e 21 dias para internacionais. Passagens compradas sem aprovação prévia não são reembolsadas.',
  },
  {
    id: 'c-sla-manutencao',
    doc: 'Contrato de serviços Alfa × Beta',
    text: 'Anexo III – Janelas de manutenção. Manutenções programadas serão comunicadas com 72 horas de antecedência e realizadas preferencialmente aos domingos, entre 0h e 6h. O tempo de indisponibilidade decorrente de manutenção programada não é computado para fins de apuração dos níveis de serviço do Anexo II.',
  },
  {
    id: 'r-bolo-fuba',
    doc: 'Caderno de receitas',
    text: 'Bolo de fubá cremoso. Bata no liquidificador 4 ovos, 1 litro de leite, 2 xícaras de açúcar, 1 xícara de fubá, 3 colheres de farinha de trigo, 50 g de queijo parmesão ralado e 1 colher de fermento. A massa fica bem líquida mesmo. Asse a 180 °C por cerca de 50 minutos: a camada de creme se forma sozinha no meio do bolo.',
  },
  {
    id: 't-backup-arquivos',
    doc: 'Guia de operações',
    text: 'Backup de arquivos enviados pelos clientes. Os anexos ficam no bucket S3 milibot-uploads-prod, com versionamento ativado e replicação para outra região. Versões apagadas são mantidas por 90 dias. Não há snapshot diário: a recuperação é feita restaurando a versão anterior do objeto.',
  },
  {
    id: 'f-cartao-corporativo',
    doc: 'Política de compras',
    text: 'Cartão corporativo. O cartão é destinado a despesas recorrentes de pequeno valor, como assinaturas de software, com limite mensal de R$ 3.000 por portador. Toda fatura deve ser conciliada no ERP até o dia 5 do mês seguinte, com nota fiscal anexada a cada lançamento.',
  },
]

export const QUERIES: EvalQuery[] = [
  // Paraphrases: little or no word overlap with the answer
  {
    kind: 'paraphrase',
    query: 'Até quando o cliente precisa quitar a mensalidade do serviço e o que acontece se atrasar?',
    expected: ['c-pagamento'],
  },
  { kind: 'paraphrase', query: 'Como o preço do contrato é corrigido todo ano?', expected: ['c-reajuste'] },
  {
    kind: 'paraphrase',
    query: 'Quero encerrar o contrato sem justificativa, com quanto tempo preciso avisar?',
    expected: ['c-rescisao'],
  },
  {
    kind: 'paraphrase',
    query: 'Depois que o contrato acabar, por quanto tempo ainda tenho que guardar segredo das informações?',
    expected: ['c-confidencialidade'],
  },
  {
    kind: 'paraphrase',
    query: 'Em que cidade seria julgado um processo sobre esse contrato?',
    expected: ['c-foro'],
  },
  {
    kind: 'paraphrase',
    query: 'Se o sistema cair inteiro, em quanto tempo o fornecedor tem que atender?',
    expected: ['c-sla'],
  },
  {
    kind: 'paraphrase',
    query: 'O expresso está saindo ralo e muito depressa, o que eu mudo na máquina?',
    expected: ['m-moagem'],
  },
  {
    kind: 'paraphrase',
    query: 'De quanto em quanto tempo preciso tirar o calcário da cafeteira?',
    expected: ['m-descalcificacao'],
  },
  {
    kind: 'paraphrase',
    query: 'Como faço espuma no leite para cappuccino sem entupir a saída?',
    expected: ['m-vapor'],
  },
  {
    kind: 'paraphrase',
    query: 'Comprei a máquina de café, como consigo dois anos de cobertura contra defeito?',
    expected: ['m-garantia'],
  },
  {
    kind: 'paraphrase',
    query: 'O que fazer antes de preparar o primeiro café na máquina nova?',
    expected: ['m-primeiro-uso'],
  },
  { kind: 'paraphrase', query: 'Receita de peixe no estilo do Espírito Santo', expected: ['r-moqueca'] },
  {
    kind: 'paraphrase',
    query: 'Quantos dias o feijão que sobrou aguenta na geladeira?',
    expected: ['r-conservacao'],
  },
  {
    kind: 'paraphrase',
    query: 'Qual goma de mandioca deixa o pão de queijo mais crocante?',
    expected: ['r-pao-queijo'],
  },
  { kind: 'paraphrase', query: 'Como deixar o arroz italiano bem cremoso?', expected: ['r-risoto'] },
  {
    kind: 'paraphrase',
    query: 'Quem precisa autorizar a compra de um equipamento de 20 mil reais?',
    expected: ['f-aprovacao-compras'],
  },
  {
    kind: 'paraphrase',
    query: 'O fornecedor mandou a nota no dia 28, em que mês ela é contabilizada?',
    expected: ['f-nota-fiscal'],
  },
  {
    kind: 'paraphrase',
    query: 'Onde a empresa deixa rendendo o dinheiro que sobra em caixa?',
    expected: ['f-investimento'],
  },
  {
    kind: 'paraphrase',
    query: 'Os clientes estão pagando com mais atraso? Qual segmento piorou?',
    expected: ['f-inadimplencia'],
  },
  { kind: 'paraphrase', query: 'Posso tirar meu descanso anual em partes?', expected: ['h-ferias'] },
  {
    kind: 'paraphrase',
    query: 'A empresa ajuda a pagar a internet de quem trabalha de casa?',
    expected: ['h-home-office'],
  },
  {
    kind: 'paraphrase',
    query: 'Quanto posso gastar com hotel numa viagem a trabalho para Belo Horizonte?',
    expected: ['h-reembolso'],
  },
  {
    kind: 'paraphrase',
    query: 'Quantos dias de folga o pai ganha quando o bebê nasce?',
    expected: ['h-licenca-parental'],
  },
  {
    kind: 'paraphrase',
    query: 'Em que meses acontecem as avaliações de performance?',
    expected: ['h-avaliacao'],
  },
  {
    kind: 'paraphrase',
    query: 'Posso aceitar uma cesta de Natal cara que um fornecedor mandou?',
    expected: ['h-codigo-conduta'],
  },
  {
    kind: 'paraphrase',
    query: 'Dá para subir uma versão nova para os clientes na sexta à tarde?',
    expected: ['t-deploy'],
  },
  {
    kind: 'paraphrase',
    query: 'O site está devolvendo bad gateway, qual a causa mais provável?',
    expected: ['t-erro-502'],
  },
  {
    kind: 'paraphrase',
    query: 'Por quanto tempo a credencial de acesso da API continua válida?',
    expected: ['t-api-auth'],
  },
  {
    kind: 'paraphrase',
    query: 'Se o banco corromper, quantos minutos de dados podemos perder no máximo?',
    expected: ['t-backup-db'],
  },
  {
    kind: 'paraphrase',
    query: 'Como volto atrás uma versão problemática que acabou de ir ao ar?',
    expected: ['t-rollback'],
  },
  {
    kind: 'paraphrase',
    query: 'O sistema caiu para vários clientes, quem coordena a resposta?',
    expected: ['t-incidente'],
  },
  {
    kind: 'paraphrase',
    query: 'O que a pessoa tem que entregar no último dia antes de sair da empresa?',
    expected: ['h-desligamento'],
  },

  // Exact terms: codes, names, commands
  { kind: 'exact', query: 'E04', expected: ['m-erro-e04'] },
  { kind: 'exact', query: 'CC-310', expected: ['f-centro-custo'] },
  { kind: 'exact', query: 'kubectl rollout undo', expected: ['t-rollback'] },
  { kind: 'exact', query: 'secret/data/api/prod', expected: ['t-variaveis'] },
  { kind: 'exact', query: 'IPCA', expected: ['c-reajuste'] },
  { kind: 'exact', query: 'HTTP 429 Retry-After', expected: ['t-api-auth'] },
  { kind: 'exact', query: 'Comarca de Campinas', expected: ['c-foro'] },
  { kind: 'exact', query: 'Lei 13.709/2018', expected: ['c-lgpd'] },

  // Answers spread over several passages
  {
    kind: 'spread',
    query: 'Quais multas e descontos o contrato de serviços prevê por atraso ou descumprimento?',
    expected: ['c-pagamento', 'c-rescisao', 'c-sla'],
  },
  {
    kind: 'spread',
    query: 'O que preciso para rodar a API na minha máquina e onde ficam os segredos de produção?',
    expected: ['t-onboarding-dev', 't-variaveis'],
  },
  {
    kind: 'spread',
    query: 'Quais mensagens de erro a cafeteira pode mostrar no visor?',
    expected: ['m-erro-e04', 'm-erro-e07'],
  },
  {
    kind: 'spread',
    query: 'Regras de gastos: quem aprova compras e como pedir reembolso de viagem',
    expected: ['f-aprovacao-compras', 'h-reembolso'],
  },
  {
    kind: 'spread',
    query: 'Quais receitas de moqueca temos?',
    expected: ['r-moqueca', 'r-moqueca-baiana'],
  },
  {
    kind: 'spread',
    query: 'Como o fornecedor deve tratar os dados pessoais e as informações sigilosas?',
    expected: ['c-lgpd', 'c-confidencialidade'],
  },
  // English questions over Portuguese documents (the bots' prompts are in English)
  {
    kind: 'crosslingual',
    query: 'What is the late payment penalty in the services contract?',
    expected: ['c-pagamento'],
  },
  {
    kind: 'crosslingual',
    query: 'How many days of notice are needed to terminate the agreement without cause?',
    expected: ['c-rescisao'],
  },
  { kind: 'crosslingual', query: 'How do I descale the espresso machine?', expected: ['m-descalcificacao'] },
  {
    kind: 'crosslingual',
    query: 'What does error E07 on the coffee maker mean?',
    expected: ['m-erro-e07'],
  },
  {
    kind: 'crosslingual',
    query: 'Can I split my vacation into several periods?',
    expected: ['h-ferias'],
  },
  {
    kind: 'crosslingual',
    query: 'What is the daily meal allowance on business trips?',
    expected: ['h-reembolso'],
  },
  {
    kind: 'crosslingual',
    query: 'Who must approve purchases above fifty thousand reais?',
    expected: ['f-aprovacao-compras'],
  },
  {
    kind: 'crosslingual',
    query: 'How long does the API access token last and what is the rate limit?',
    expected: ['t-api-auth'],
  },
  {
    kind: 'crosslingual',
    query: 'How do I roll back a bad production release?',
    expected: ['t-rollback'],
  },
  {
    kind: 'crosslingual',
    query: 'Recipe for Brazilian cheese bread',
    expected: ['r-pao-queijo'],
  },
  {
    kind: 'crosslingual',
    query: 'Where are production secrets stored?',
    expected: ['t-variaveis'],
  },
  {
    kind: 'crosslingual',
    query: 'What is the recovery point objective of the database backups?',
    expected: ['t-backup-db'],
  },

  // Harder paraphrases next to the distractors
  {
    kind: 'paraphrase',
    query: 'A cafeteira tem quanto tempo de garantia se eu não registrar no site?',
    expected: ['m-garantia'],
  },
  {
    kind: 'paraphrase',
    query: 'Preciso de autorização antes de comprar a passagem de avião?',
    expected: ['f-aprovacao-viagens'],
  },
  {
    kind: 'paraphrase',
    query: 'A parada programada de domingo de madrugada conta como indisponibilidade no SLA?',
    expected: ['c-sla-manutencao'],
  },
  {
    kind: 'paraphrase',
    query: 'Um cliente apagou sem querer um arquivo que tinha enviado, dá para recuperar?',
    expected: ['t-backup-arquivos'],
  },
]
