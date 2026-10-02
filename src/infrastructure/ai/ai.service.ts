import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IAIService, GenerateQuestionInput, EvaluateAnswerInput, GenerateFeedbackInput } from '../../domain/interfaces/ai.interface';
import { InterviewFeedback, VisionMetrics, Language } from '../../domain/entities/interview.entity';

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

interface ChatOptions {
  /** Ollama structured output — constrains the model to emit valid JSON. */
  format?: 'json';
  temperature?: number;
}

// ─── System Prompts ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT_PT = `Você é Alex, um entrevistador técnico sênior.
REGRA ABSOLUTA: NUNCA escreva colchetes [ ] nas suas respostas. NUNCA use placeholders como [Nome], [Cargo], [Empresa]. Use sempre os valores reais fornecidos no prompt.

Tipos de perguntas que você DEVE usar (varie entre eles — não repita o mesmo estilo):
- Situacionais: "Descreva uma situação em que você teve que..."
- Trade-off: "Quais são as vantagens e desvantagens de X vs Y?"
- Aprofundamento: "Como você garantiria a escalabilidade disso?"
- Debugging: "Como você investigaria um problema de performance em produção?"
- System design: "Como você projetaria um sistema que..."

Diretrizes:
- Seja direto, analítico e exigente — não aceite respostas superficiais sem aprofundar
- Faça follow-up se a resposta for vaga: "Pode detalhar mais como funciona X?"
- IMPORTANTE: Evite repetir temas ou estilos de pergunta já abordados na conversa
- Aumente progressivamente a dificuldade conforme o candidato responde bem
- Avalie raciocínio, profundidade técnica, clareza e experiência prática
- Responda sempre em português`;

const SYSTEM_PROMPT_EN = `You are Alex, a senior technical interviewer.
ABSOLUTE RULE: NEVER write brackets [ ] in your responses. NEVER use placeholders like [Name], [Role], [Company]. Always use the actual values provided.

Question types you MUST use (vary between them — do not repeat the same style):
- Situational: "Describe a situation where you had to..."
- Trade-off: "What are the pros and cons of X vs Y?"
- Deep dive: "How would you ensure scalability here?"
- Debugging: "How would you investigate a performance issue in production?"
- System design: "How would you design a system that..."

Guidelines:
- Be direct, analytical, and demanding — do not accept superficial answers without probing
- Follow up if the answer is vague: "Can you elaborate on how X works?"
- IMPORTANT: Avoid repeating topics or question styles already covered in the conversation
- Progressively increase difficulty as the candidate responds well
- Evaluate reasoning, technical depth, clarity, and practical experience
- Always respond in English`;

// ─── Question Progressions ───────────────────────────────────────────────────
// Each level has 3 variant tracks so the same candidate gets different questions
// across sessions. Variant is randomly assigned at interview creation.

// variant 1 → implementação / algoritmos / live coding
// variant 2 → arquitetura / design / decisões
// variant 3 → performance / banco de dados / escalabilidade

const PROGRESSION_PT: Record<string, Record<number, string[]>> = {
  junior: {
    1: [
      'apresentação: background e motivação para entrar na área de tecnologia',
      'fundamentos da linguagem da vaga: tipos, escopos e paradigma (OOP ou funcional)',
      'estruturas de dados: arrays vs listas encadeadas — diferenças e quando usar cada uma',
      'algoritmos: complexidade Big-O — peça para analisar a complexidade de algum algoritmo conhecido',
      'live coding: proponha um desafio algorítmico simples adequado ao nível júnior — o candidato deve explicar a abordagem antes de codificar',
      'algoritmos de busca e ordenação: explore como o candidato entende busca eficiente em coleções',
      'qualidade de código: o que torna um código limpo e de fácil manutenção?',
      'testes: como você aborda testes unitários? Já usou TDD?',
      'debugging: descreva seu processo ao encontrar um bug difícil de reproduzir',
      'evolução: qual área técnica você quer aprofundar nos próximos meses e por quê?',
    ],
    2: [
      'apresentação: primeiro projeto ou experiência que te fez querer ser desenvolvedor(a)',
      'fundamentos: gerenciamento de memória na linguagem da vaga — como funciona e quais os riscos?',
      'estruturas de dados: hash maps — funcionamento interno e complexidade de operações',
      'algoritmos: recursão vs iteração — prós, contras e quando escolher cada abordagem',
      'live coding: proponha um problema de manipulação de dados ou lógica simples — peça raciocínio em voz alta antes do código',
      'orientação a objetos: os pilares (herança, polimorfismo, encapsulamento) com exemplos práticos',
      'padrões de projeto: explore se o candidato já usou algum e por que escolheu',
      'tratamento de erros: como o candidato lida com erros e exceções no código?',
      'versionamento: fluxo de trabalho com Git em equipe (branches, PRs, code review)',
      'aprendizado: como o candidato aprende uma nova tecnologia ou framework?',
    ],
    3: [
      'apresentação: um projeto pessoal do qual o candidato se orgulha — o que faz e como foi construído',
      'fundamentos: semântica de comparação e igualdade na linguagem da vaga — peça um exemplo real que já causou bug',
      'estruturas de dados: pilhas e filas — peça um caso de uso real para cada uma',
      'algoritmos: memoização — o que é e quando aplicar? Peça um exemplo concreto',
      'live coding: proponha um problema de iteração ou lógica condicional — enfatize o raciocínio passo a passo mais do que a velocidade',
      'performance básica: como o candidato abordaria a otimização de um trecho de código lento?',
      'colaboração: descreva uma divergência técnica em equipe e como foi resolvida',
      'testes: quais tipos de teste existem e o que cada um verifica?',
      'debugging: qual foi o bug mais difícil já corrigido? Como chegou à causa raiz?',
      'encerramento: o que o candidato faria diferente em um projeto anterior com o conhecimento de hoje?',
    ],
  },
  mid: {
    1: [
      'apresentação: sua área técnica mais forte e um projeto que a demonstra',
      'linguagem: generics, closures ou metaprogramação — como e quando você os usa?',
      'estruturas de dados: árvores e grafos — DFS vs BFS com análise de complexidade',
      'algoritmos: programação dinâmica — explique com um exemplo concreto que já usou',
      'live coding: resolva um problema de complexidade média e justifique cada decisão (abordagem, estrutura, complexidade)',
      'performance de aplicação: como você perfilha e identifica gargalos? Quais ferramentas usa?',
      'banco de dados: otimização de queries — índices, EXPLAIN/EXPLAIN ANALYZE, problema N+1',
      'princípios SOLID: dê um exemplo real de como aplicou cada princípio',
      'testes: testes de integração vs unitários — quando usar cada um e o que cada tipo garante?',
      'encerramento: qual refatoração ou melhoria técnica você mais se orgulha? O que motivou e qual foi o impacto?',
    ],
    2: [
      'apresentação: um sistema que você projetou ou no qual contribuiu significativamente',
      'padrões de projeto: factory, observer, strategy — descreva cenários reais de uso',
      'estruturas de dados: quando você escolheria uma heap ao invés de um array ordenado?',
      'concorrência: threads, coroutines ou async/await — trade-offs em cada abordagem',
      'live coding: modele uma hierarquia de classes para um domínio de negócio — justifique as abstrações',
      'arquitetura: monolito vs microsserviços — o que guiou a última decisão arquitetural em que participou?',
      'banco de dados: normalização vs desnormalização — quando cada uma faz sentido?',
      'design de API: REST vs GraphQL — trade-offs de design e manutenção',
      'cache: estratégias (LRU, write-through, write-back) e quando aplicar cada uma',
      'encerramento: descreva uma dívida técnica que você endereçou — como identificou, priorizou e executou?',
    ],
    3: [
      'apresentação: um desafio de performance que você resolveu — contexto, causa raiz e solução',
      'linguagem: como funciona o gerenciamento de memória (GC, vazamentos) na sua linguagem principal?',
      'estruturas de dados: quando usar uma trie vs hash map para busca em texto?',
      'algoritmos: complexidade amortizada — dê um exemplo real onde isso importa',
      'live coding: otimize uma função ineficiente — analise o antes e o depois com complexidades',
      'banco de dados: tipos de índice (B-tree, hash, composto, parcial) — quando usar cada um?',
      'banco de dados: como você interpreta um EXPLAIN PLAN? Quais os principais sinais de alerta?',
      'performance: como você identifica gargalos em produção? Quais métricas e ferramentas usa?',
      'concorrência: race conditions e deadlocks — como prevenir e detectar?',
      'encerramento: qual foi o maior ganho de performance que você já entregou? Como mediu o resultado?',
    ],
  },
  senior: {
    1: [
      'apresentação: contribuição técnica de maior impacto na sua carreira — o que construiu e qual o resultado?',
      'linguagem: internals avançados — event loop, ajuste de GC ou compilação JIT, conforme a stack',
      'algoritmos: problemas NP-difíceis em produção — como você os aborda na prática?',
      'live coding: resolva um problema complexo com múltiplas abordagens válidas — compare os trade-offs de cada uma',
      'banco de dados: indexação avançada — índices parciais, covering indexes, index-only scans',
      'performance em escala: sharding, read replicas, connection pooling — quando e por quê cada estratégia?',
      'system design: projete um rate limiter distribuído para 100 mil requisições/segundo',
      'sistemas distribuídos: teorema CAP — como você toma decisões de consistência em produção?',
      'confiabilidade: circuit breakers, bulkhead pattern, chaos engineering — como aplica na prática?',
      'encerramento: como você avalia se um sistema está pronto para 10x de tráfego?',
    ],
    2: [
      'apresentação: uma decisão técnica estratégica que você liderou do início ao fim — impacto e aprendizados',
      'arquitetura: event sourcing vs CQRS — quando e por quê adotar? Quais as armadilhas?',
      'dados: persistência poliglota — como você escolhe o banco certo para cada workload?',
      'system design: projete um sistema de notificações que processe 1 milhão de eventos por segundo',
      'liderança técnica: como você conduz revisões arquiteturais e garante padrões de engenharia no time?',
      'sistemas distribuídos: consistência eventual — como você raciocina e testa comportamentos assíncronos?',
      'performance: identificação e resolução de falhas em cascata em microsserviços',
      'observabilidade: o que compõe um stack de observabilidade production-ready? (logs, métricas, traces)',
      'gestão de time: como você faz mentoria e melhora a velocidade do time sem criar dependência?',
      'encerramento: descreva uma situação em que você discordou de stakeholders em uma decisão técnica — como conduziu?',
    ],
    3: [
      'apresentação: um desafio de escalabilidade que você resolveu do zero — arquitetura antes e depois',
      'banco de dados: write amplification, LSM trees vs B-trees — em que workloads cada um se destaca?',
      'cache: cache stampede, estratégias de invalidação e configuração de CDN para alta disponibilidade',
      'performance: regressões de plano de query em produção — como detecta e previne?',
      'live coding: projete um cache distribuído — identifique e discuta os edge cases',
      'deploy: zero-downtime deployments — blue/green, canary e feature flags — trade-offs de cada estratégia',
      'sistemas distribuídos: transações distribuídas — 2PC vs padrão Saga — quando usar cada um?',
      'segurança: OWASP em escala — injeção, autenticação, gestão de segredos em CI/CD',
      'incident response: como você conduz um post-mortem eficaz e garante que o problema não se repita?',
      'encerramento: como você influencia a cultura de engenharia de uma organização a longo prazo?',
    ],
  },
};

const PROGRESSION_EN: Record<string, Record<number, string[]>> = {
  junior: {
    1: [
      'introduction: background and what motivated the candidate to get into software engineering',
      'language fundamentals: type system, scopes, and the core paradigm (OOP or functional) of their stack',
      'data structures: arrays vs linked lists — differences and when to use each',
      'algorithms: Big-O complexity — ask the candidate to analyze the complexity of an algorithm they know',
      'live coding: propose a simple algorithmic challenge appropriate for junior level — candidate must explain their approach before writing any code',
      'algorithms: efficient search in collections — explore how the candidate thinks about finding elements',
      'code quality: what makes code clean and easy to maintain?',
      'testing: how do they approach unit testing? Have they used TDD?',
      'debugging: describe the process when dealing with a bug that is hard to reproduce',
      'growth: what technical area do they want to deepen in the next few months and why?',
    ],
    2: [
      'introduction: the first project or experience that made them want to be a developer',
      'language internals: memory management in their primary language — how it works and what can go wrong',
      'data structures: hash maps — internal mechanics and complexity of operations',
      'algorithms: recursion vs iteration — pros, cons, and when to choose each',
      'live coding: propose a data manipulation or logic problem — ask the candidate to reason out loud before coding',
      'OOP: the three pillars (inheritance, polymorphism, encapsulation) with practical examples',
      'design patterns: explore whether the candidate has used any and why they chose it',
      'error handling: how do they handle errors and exceptions in their code?',
      'version control: Git workflow in a team setting (branches, PRs, code review)',
      'learning: how do they approach picking up a new technology or framework?',
    ],
    3: [
      'introduction: a personal project they are proud of — what it does and how it was built',
      'language: equality and comparison semantics in their language — ask for a real example that once caused a bug',
      'data structures: stacks and queues — ask for a real-world use case for each',
      'algorithms: memoization — what it is and when to apply it, with a concrete example',
      'live coding: propose an iteration or conditional logic problem — emphasize step-by-step reasoning over speed',
      'performance basics: how would they approach optimizing a slow block of code?',
      'collaboration: describe a technical disagreement in a team and how it was resolved',
      'testing: what types of tests exist and what does each verify?',
      'debugging: what is the hardest bug they have ever fixed? How did they find the root cause?',
      'closing: what would they do differently in a past project with their current knowledge?',
    ],
  },
  mid: {
    1: [
      'introduction: your strongest technical area and a project that demonstrates it',
      'language deep-dive: generics, closures, or metaprogramming — how and when do you use them?',
      'data structures: trees and graphs — DFS vs BFS with complexity analysis',
      'algorithms: dynamic programming — explain with a concrete example you have actually used',
      'live coding: solve a medium-complexity problem and justify each decision (approach, data structure, complexity)',
      'application performance: how do you profile and identify bottlenecks? What tools do you use?',
      'database: query optimization — indexes, EXPLAIN/EXPLAIN ANALYZE, and the N+1 problem',
      'SOLID principles: give a real example of applying each principle in production code',
      'testing: integration tests vs unit tests — when to use each and what each type guarantees',
      'closing: what refactoring or technical improvement are you most proud of? What drove it and what was the impact?',
    ],
    2: [
      'introduction: a system you designed or significantly contributed to',
      'design patterns: factory, observer, strategy — describe real use cases for each',
      'data structures: when would you choose a heap over a sorted array?',
      'concurrency: threads, coroutines, or async/await — trade-offs in each approach',
      'live coding: model a class hierarchy for a business domain — justify your abstractions',
      'architecture: monolith vs microservices — what drove the last architectural decision you were part of?',
      'database: normalization vs denormalization — when does each make sense?',
      'API design: REST vs GraphQL — design and maintenance trade-offs',
      'caching: strategies (LRU, write-through, write-back) and when to apply each',
      'closing: describe a technical debt you addressed — how did you identify, prioritize, and execute it?',
    ],
    3: [
      'introduction: a performance challenge you solved — context, root cause, and solution',
      'language: how does memory management (GC, leaks) work in your primary language?',
      'data structures: when would you use a trie vs a hash map for text search?',
      'algorithms: amortized complexity — give a real example where it matters in practice',
      'live coding: optimize an inefficient function — analyze the before and after with their complexities',
      'database: index types (B-tree, hash, composite, partial) — when to use each?',
      'database: how do you interpret an EXPLAIN PLAN? What are the main warning signs?',
      'performance: how do you identify bottlenecks in production? What metrics and tools do you rely on?',
      'concurrency: race conditions and deadlocks — how do you prevent and detect them?',
      'closing: what is the biggest performance gain you have delivered? How did you measure the result?',
    ],
  },
  senior: {
    1: [
      'introduction: your highest-impact technical contribution — what you built and what the outcome was',
      'language internals: event loop tuning, GC configuration, or JIT compilation behavior in your stack',
      'algorithms: NP-hard problems in production — how do you handle them practically?',
      'live coding: solve a complex problem with multiple valid approaches — compare the trade-offs of each',
      'database: advanced indexing — partial indexes, covering indexes, and index-only scans',
      'performance at scale: sharding, read replicas, and connection pooling — when and why each strategy?',
      'system design: design a distributed rate limiter handling 100k requests per second',
      'distributed systems: CAP theorem — how do you make consistency trade-offs in production?',
      'reliability: circuit breakers, bulkhead pattern, chaos engineering — how do you apply them in practice?',
      'closing: how do you evaluate whether a system is ready for 10x traffic?',
    ],
    2: [
      'introduction: a strategic technical decision you owned end-to-end — impact and lessons learned',
      'architecture: event sourcing vs CQRS — when and why to adopt? What are the pitfalls?',
      'data: polyglot persistence — how do you choose the right database for each workload?',
      'system design: design a notification system that processes 1 million events per second',
      'tech lead: how do you run architectural reviews and enforce engineering standards across the team?',
      'distributed systems: eventual consistency — how do you reason about and test asynchronous behavior?',
      'performance: identifying and resolving cascading failures in a microservices architecture',
      'observability: what does a production-ready observability stack look like? (logs, metrics, traces)',
      'team impact: how do you mentor engineers and improve team velocity without creating dependency?',
      'closing: describe a time you pushed back on stakeholders on a technical decision — how did you handle it and what was the outcome?',
    ],
    3: [
      'introduction: a scaling challenge you solved from scratch — the architecture before and after',
      'database: write amplification, LSM trees vs B-trees — in what workloads does each excel?',
      'caching: cache stampede, invalidation strategies, and CDN configuration for high availability',
      'performance: query plan regressions in production — how do you detect and prevent them?',
      'live coding: design a distributed cache — identify and discuss the edge cases',
      'deployment: zero-downtime deployments — blue/green, canary, and feature flags — trade-offs of each',
      'distributed systems: distributed transactions — 2PC vs the Saga pattern — when to use each?',
      'security: OWASP at scale — injection, authentication, and secrets management in CI/CD pipelines',
      'incident response: how do you run an effective post-mortem and ensure the problem does not recur?',
      'closing: how do you influence engineering culture across an organization over the long term?',
    ],
  },
};

const VARIANT_FOCUS_PT: Record<number, string> = {
  1: 'Foco em implementação, algoritmos e live coding — peça ao candidato para explicar o raciocínio e justificar escolhas técnicas antes e durante a implementação.',
  2: 'Foco em arquitetura, padrões de projeto e system design — explore decisões, trade-offs e os "porquês" por trás de cada escolha.',
  3: 'Foco em performance, otimização de queries, indexação e escalabilidade — investigue como o candidato mede e melhora a performance de sistemas reais.',
};

const VARIANT_FOCUS_EN: Record<number, string> = {
  1: 'Focus on implementation, algorithms, and live coding — ask the candidate to explain their reasoning and justify technical choices before and during coding.',
  2: 'Focus on architecture, design patterns, and system design — probe decisions, trade-offs, and the reasoning behind each choice.',
  3: 'Focus on performance, query optimization, indexing, and scalability — explore how the candidate measures and improves real system performance.',
};

// ─── Input Sanitization ──────────────────────────────────────────────────────

function sanitizeInput(value: string, maxLength = 200): string {
  return value.replace(/[<>"'`\\]/g, '').trim().slice(0, maxLength);
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class AIService implements IAIService {
  private readonly logger = new Logger(AIService.name);
  private readonly ollamaUrl: string;
  private readonly model: string;

  constructor(private readonly configService: ConfigService) {
    this.ollamaUrl = this.configService.get('OLLAMA_URL', 'http://localhost:11434');
    this.model = this.configService.get('OLLAMA_MODEL', 'llama3.1:8b');
  }

  async generateQuestion(input: GenerateQuestionInput): Promise<string> {
    const lang = input.language ?? 'pt';
    const level = input.experienceLevel ?? 'mid';
    const variant = input.sessionVariant ?? 1;
    const candidateName = sanitizeInput(input.candidateName);
    const role = sanitizeInput(input.role);

    const systemPrompt = lang === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_PT;
    const progressionTrack = (lang === 'en' ? PROGRESSION_EN[level] : PROGRESSION_PT[level])?.[variant]
      ?? (lang === 'en' ? PROGRESSION_EN['mid'][1] : PROGRESSION_PT['mid'][1]);
    const variantFocus = lang === 'en' ? VARIANT_FOCUS_EN[variant] ?? '' : VARIANT_FOCUS_PT[variant] ?? '';
    const visionContext = this.buildVisionContext(input.visionMetrics, lang);

    const cvContext = input.cvContext
      ? (lang === 'en'
          ? `\nCandidate CV summary:\n${input.cvContext}`
          : `\nResumo do CV do candidato:\n${input.cvContext}`)
      : '';

    const topicsContext = (input.previousTopics && input.previousTopics.length > 0)
      ? (lang === 'en'
          ? `\nTopics already covered in previous sessions (avoid repeating): ${input.previousTopics.join(', ')}.`
          : `\nTópicos já abordados em sessões anteriores (evite repetir): ${input.previousTopics.join(', ')}.`)
      : '';

    // 0-based index of the question being generated = answers given so far.
    // (Counting history pairs is wrong: each answer adds an evaluation AND a question.)
    const questionIndex = input.conversationHistory.filter((m) => m.role === 'user').length;
    const maxQuestions = input.maxQuestions && input.maxQuestions > 0 ? input.maxQuestions : 10;
    // The progression tables are written for 10 steps — stretch/compress them to the session length
    const progressionPos = progressionTrack.length === maxQuestions
      ? questionIndex
      : Math.floor((questionIndex * progressionTrack.length) / maxQuestions);
    const progressionHint = progressionTrack[Math.min(progressionPos, progressionTrack.length - 1)];

    let userPrompt: string;

    if (input.conversationHistory.length === 0) {
      if (lang === 'en') {
        userPrompt = `The candidate's name is ${candidateName}, applying for ${role} (level: ${level}).
Greet them using exactly the name "${candidateName}" and ask the first question about: ${progressionHint}.
Example: "Hello, ${candidateName}! ..."
${variantFocus}
${visionContext}${cvContext}${topicsContext}`;
      } else {
        userPrompt = `O candidato se chama ${candidateName} e está aplicando para ${role} (nível: ${level}).
Cumprimente-o(a) usando exatamente o nome "${candidateName}" e faça a primeira pergunta sobre: ${progressionHint}.
Exemplo: "Olá, ${candidateName}! ..."
${variantFocus}
${visionContext}${cvContext}${topicsContext}`;
      }
    } else {
      if (lang === 'en') {
        userPrompt = `Candidate: ${candidateName} | Role: ${role} | Level: ${level} | Question ${questionIndex + 1}/${maxQuestions} | Focus: ${progressionHint}.
Ask the next question — more challenging than the previous one, on a DIFFERENT topic or angle from what was already covered.
${variantFocus}
${visionContext}${cvContext}${topicsContext}
Reply with ONLY the question, no introductions.`;
      } else {
        userPrompt = `Candidato: ${candidateName} | Vaga: ${role} | Nível: ${level} | Pergunta ${questionIndex + 1}/${maxQuestions} | Foco: ${progressionHint}.
Faça a próxima pergunta — mais desafiadora que a anterior, sobre um TEMA ou ÂNGULO DIFERENTE do que já foi abordado.
${variantFocus}
${visionContext}${cvContext}${topicsContext}
Responda APENAS com a pergunta, sem introduções.`;
      }
    }

    const messages: OllamaMessage[] = [
      { role: 'system', content: systemPrompt },
      ...input.conversationHistory.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: userPrompt },
    ];

    return this.chat(messages);
  }

  async evaluateAnswer(input: EvaluateAnswerInput): Promise<string> {
    const lang = input.language ?? 'pt';
    const systemPrompt = lang === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_PT;
    const visionContext = this.buildVisionContext(input.visionMetrics, lang);

    let prompt: string;
    if (lang === 'en') {
      prompt = `The question asked was: "${input.question}"

The candidate answered: "${input.answer}"

${visionContext}

Provide a brief response (2-3 sentences) acknowledging the answer and making a constructive comment before continuing the interview.
Do NOT ask the next question now — only evaluate this answer briefly.`;
    } else {
      prompt = `A pergunta feita foi: "${input.question}"

O candidato respondeu: "${input.answer}"

${visionContext}

Forneça uma resposta breve (2-3 frases) reconhecendo a resposta e fazendo um comentário construtivo antes de continuar a entrevista.
Não faça a próxima pergunta agora — apenas avalie esta resposta brevemente.`;
    }

    return this.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ]);
  }

  async generateFeedback(input: GenerateFeedbackInput): Promise<InterviewFeedback> {
    const lang = input.language ?? 'pt';
    const { conversationHistory, visionMetrics, role, candidateName, experienceLevel, sessionVariant } = input;

    const systemPrompt = lang === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_PT;
    const visionContext = this.buildVisionContext(visionMetrics, lang);
    const variantFocus = lang === 'en' ? VARIANT_FOCUS_EN[sessionVariant] ?? '' : VARIANT_FOCUS_PT[sessionVariant] ?? '';
    const safeName = sanitizeInput(candidateName);
    const safeRole = sanitizeInput(role);

    let prompt: string;
    if (lang === 'en') {
      prompt = `You just completed a technical interview with the following context:
- Candidate: ${safeName}
- Position: ${safeRole}
- Seniority level: ${experienceLevel}
- Session focus: ${variantFocus}

IMPORTANT — calibrate every score relative to the expected bar for a ${experienceLevel} engineer in a ${safeRole} role:
- A junior who correctly explains Big-O should score high in technical for their level.
- A senior who only covers basics should score low even if the answer is technically correct.
- Scores must reflect "how well did this candidate perform for their declared level", not an absolute scale.

${visionContext}

Based on the full interview conversation below, generate structured feedback with:
- Concrete strengths observed (specific, not generic — e.g. "articulated trade-offs between DFS and BFS clearly")
- Actionable improvement areas calibrated to their level (e.g. for junior: "practice implementing hash maps from scratch"; for senior: "go deeper on distributed consistency models")
- A personalized summary addressed to ${safeName} that mentions the role and seniority level

Return a valid JSON with exactly this structure (no markdown, no text outside the JSON):
{
  "technical": <number 0-10>,
  "communication": <number 0-10>,
  "confidence": <number 0-10>,
  "clarity": <number 0-10>,
  "overall": <number 0-10>,
  "summary": "<2-3 sentence personalized summary for ${safeName}>",
  "strengths": ["<specific strength 1>", "<specific strength 2>", "<specific strength 3>"],
  "improvements": ["<actionable improvement 1>", "<actionable improvement 2>", "<actionable improvement 3>"]
}`;
    } else {
      prompt = `Você acabou de conduzir uma entrevista técnica com o seguinte contexto:
- Candidato(a): ${safeName}
- Vaga: ${safeRole}
- Nível de senioridade: ${experienceLevel}
- Foco da sessão: ${variantFocus}

IMPORTANTE — calibre cada nota em relação ao que se espera de um(a) ${experienceLevel} para a vaga de ${safeRole}:
- Um júnior que explica Big-O corretamente deve ter nota alta em técnico para o seu nível.
- Um sênior que só cobre o básico deve ter nota baixa, mesmo que a resposta esteja correta.
- As notas devem refletir "quão bem esse candidato performou para o nível declarado", não uma escala absoluta.

${visionContext}

Com base na conversa completa da entrevista abaixo, gere um feedback estruturado com:
- Pontos fortes concretos observados (específicos, não genéricos — ex.: "articulou bem os trade-offs entre DFS e BFS")
- Áreas de melhoria acionáveis calibradas ao nível (ex. para júnior: "pratique implementar hash maps do zero"; para sênior: "aprofunde modelos de consistência distribuída")
- Um resumo personalizado dirigido a ${safeName} que mencione a vaga e o nível de senioridade

Retorne um JSON válido com exatamente esta estrutura (sem markdown, sem texto fora do JSON):
{
  "technical": <número 0-10>,
  "communication": <número 0-10>,
  "confidence": <número 0-10>,
  "clarity": <número 0-10>,
  "overall": <número 0-10>,
  "summary": "<resumo personalizado em 2-3 frases para ${safeName}>",
  "strengths": ["<ponto forte específico 1>", "<ponto forte específico 2>", "<ponto forte específico 3>"],
  "improvements": ["<melhoria acionável 1>", "<melhoria acionável 2>", "<melhoria acionável 3>"]
}`;
    }

    const messages: OllamaMessage[] = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.map((m: { role: 'user' | 'assistant'; content: string }) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: prompt },
    ];

    // format: 'json' makes Ollama constrain decoding to valid JSON; the
    // normaliser still tolerates stray text and loosely-typed fields.
    // Transport errors propagate so the caller can report failure and retry.
    const text = await this.chat(messages, { format: 'json', temperature: 0.4 });

    try {
      return this.normalizeFeedback(this.extractJson(text), lang);
    } catch (err) {
      this.logger.error(`Failed to parse feedback JSON: ${(err as Error).message}`);
      return this.defaultFeedback(lang);
    }
  }

  // ── Feedback normalisation ────────────────────────────────────────────────

  private extractJson(text: string): Record<string, unknown> {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');
      return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    }
  }

  /** Accepts 8, "8", "8/10", "8.5 / 10", "80%" — returns a 0-10 score or null. */
  private parseScore(value: unknown): number | null {
    let n: number;
    if (typeof value === 'number') {
      n = value;
    } else if (typeof value === 'string') {
      const fraction = value.match(/(-?\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)/);
      const percent = value.match(/(-?\d+(?:[.,]\d+)?)\s*%/);
      const plain = value.match(/-?\d+(?:[.,]\d+)?/);
      if (fraction) {
        const den = parseFloat(fraction[2].replace(',', '.'));
        n = den > 0 ? (parseFloat(fraction[1].replace(',', '.')) / den) * 10 : NaN;
      } else if (percent) {
        n = parseFloat(percent[1].replace(',', '.')) / 10;
      } else if (plain) {
        n = parseFloat(plain[0].replace(',', '.'));
      } else {
        return null;
      }
    } else {
      return null;
    }
    if (!Number.isFinite(n)) return null;
    return Math.round(Math.min(10, Math.max(0, n)) * 10) / 10;
  }

  private parseStringList(value: unknown): string[] {
    let items: unknown[];
    if (Array.isArray(value)) {
      items = value;
    } else if (typeof value === 'string') {
      // "a; b" / "- a\n- b" / "1. a\n2. b"
      items = value.split(/\n|;|•/).map((v) => v.replace(/^\s*(?:[-*]|\d+[.)])\s*/, ''));
    } else {
      return [];
    }
    return items
      .map((v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''))
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
      .slice(0, 10);
  }

  private normalizeFeedback(raw: Record<string, unknown>, lang: Language): InterviewFeedback {
    const fallback = this.defaultFeedback(lang);
    const technical = this.parseScore(raw.technical);
    const communication = this.parseScore(raw.communication);
    const confidence = this.parseScore(raw.confidence);
    const clarity = this.parseScore(raw.clarity);

    const known = [technical, communication, confidence, clarity].filter((v): v is number => v !== null);
    const overall = this.parseScore(raw.overall)
      ?? (known.length > 0 ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10) / 10 : null);

    const summary = typeof raw.summary === 'string' && raw.summary.trim().length > 0
      ? raw.summary.trim()
      : fallback.summary;

    return {
      technical: technical ?? fallback.technical,
      communication: communication ?? fallback.communication,
      confidence: confidence ?? fallback.confidence,
      clarity: clarity ?? fallback.clarity,
      overall: overall ?? fallback.overall,
      summary,
      strengths: this.parseStringList(raw.strengths),
      improvements: this.parseStringList(raw.improvements),
    };
  }

  private async chat(messages: OllamaMessage[], opts: ChatOptions = {}): Promise<string> {
    const url = `${this.ollamaUrl}/api/chat`;
    this.logger.log(`[AI] POST ${url} — model: ${this.model}, messages: ${messages.length}`);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          ...(opts.format ? { format: opts.format } : {}),
          options: { temperature: opts.temperature ?? 0.8 },
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (fetchErr) {
      this.logger.error(`[AI] fetch threw (network error): ${(fetchErr as Error).message}`);
      throw fetchErr;
    }

    this.logger.log(`[AI] Ollama responded with status: ${res.status}`);

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`[AI] Ollama ${res.status} POST ${url} — ${body}`);
      throw new Error(`Ollama error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    if (data.error) {
      throw new Error(`Ollama error: ${data.error}`);
    }
    const content = data.message?.content?.trim();
    if (!content) {
      throw new Error('Ollama returned an empty response');
    }
    return content;
  }

  private buildVisionContext(metrics: VisionMetrics | null | undefined, lang: Language = 'pt'): string {
    if (!metrics) return '';
    if (lang === 'en') {
      return `
Candidate behavioral metrics (0-1):
- Eye contact: ${metrics.eye_contact.toFixed(2)}
- Stress level: ${metrics.stress_level.toFixed(2)}
- Confidence: ${metrics.confidence.toFixed(2)}
Consider this data when formulating your response.`;
    }
    return `
Métricas comportamentais do candidato (0-1):
- Contato visual: ${metrics.eye_contact.toFixed(2)}
- Nível de stress: ${metrics.stress_level.toFixed(2)}
- Confiança: ${metrics.confidence.toFixed(2)}
Considere esses dados ao formular sua resposta.`;
  }

  private defaultFeedback(lang: Language = 'pt'): InterviewFeedback {
    return {
      technical: 5,
      communication: 5,
      confidence: 5,
      clarity: 5,
      overall: 5,
      summary: lang === 'en'
        ? 'Could not generate detailed feedback.'
        : 'Não foi possível gerar feedback detalhado.',
      strengths: [],
      improvements: [],
    };
  }
}
