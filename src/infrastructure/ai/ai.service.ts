import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IAIService,
  GenerateQuestionInput,
  EvaluateAnswerInput,
  GenerateFeedbackInput,
  AIUnavailableError,
} from '../../domain/interfaces/ai.interface';
import { InterviewFeedback, VisionMetrics, Language, Interviewer } from '../../domain/entities/interview.entity';
import { toSpeechText } from '../audio/speech-text';

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
  /** Max tokens to generate (Ollama `num_predict`) — keeps short replies short. */
  numPredict?: number;
}

// ─── Interviewer persona ─────────────────────────────────────────────────────

export const PERSONA_NAMES: Record<Interviewer, string> = { male: 'Alex', female: 'Sofia' };

/** Picks the masculine or feminine Portuguese form for the interviewer persona. */
const pt = (interviewer: Interviewer, male: string, female: string) => (interviewer === 'female' ? female : male);

// ─── System Prompts ─────────────────────────────────────────────────────────

const ptIntro = (i: Interviewer) =>
  `Você é ${PERSONA_NAMES[i]}, ${pt(i, 'um entrevistador técnico sênior', 'uma entrevistadora técnica sênior')} conduzindo uma entrevista por videochamada.`;

const enIntro = (i: Interviewer) =>
  `You are ${PERSONA_NAMES[i]}, a senior technical interviewer running an interview over a video call.`;

const SPOKEN_RULES_PT = `Tudo o que você escreve será FALADO EM VOZ ALTA por um sintetizador de voz, então escreva como uma pessoa fala numa conversa:
- Texto corrido em português do Brasil, frases curtas e naturais, tratando o candidato por "você".
- NUNCA use markdown, asteriscos, títulos, listas, tópicos, emojis, código ou rótulos como "Pergunta:" ou "Avaliação:".`;

const SPOKEN_RULES_EN = `Everything you write will be SPOKEN ALOUD by a text-to-speech voice, so write the way a person talks in conversation:
- Plain flowing English, short natural sentences, addressing the candidate as "you".
- NEVER use markdown, asterisks, headings, lists, bullet points, emoji, code, or labels like "Question:" or "Evaluation:".`;

const COMMON_RULES_PT = `- Nunca diga que é uma IA ou um modelo de linguagem, e nunca cite números de métricas comportamentais.
REGRA ABSOLUTA: NUNCA escreva colchetes [ ] nas suas respostas. NUNCA use placeholders como [Nome], [Cargo], [Empresa]. Use sempre os valores reais fornecidos no prompt.`;

const COMMON_RULES_EN = `- Never say you are an AI or a language model, and never quote behavioral metric numbers.
ABSOLUTE RULE: NEVER write brackets [ ] in your responses. NEVER use placeholders like [Name], [Role], [Company]. Always use the actual values provided.`;

/** Main interviewer prompt — used to ask questions and to write the final feedback. */
export function systemPromptPt(i: Interviewer = 'male'): string {
  return `${ptIntro(i)}
${SPOKEN_RULES_PT}
- Faça UMA única pergunta por vez. Nunca junte duas ou três perguntas na mesma fala.
${COMMON_RULES_PT}

Tipos de perguntas que você DEVE usar (varie entre eles — não repita o mesmo estilo):
- Situacionais: "Descreva uma situação em que você teve que..."
- Trade-off: "Quais são as vantagens e desvantagens de X vs Y?"
- Aprofundamento: "Como você garantiria a escalabilidade disso?"
- Debugging: "Como você investigaria um problema de performance em produção?"
- System design: "Como você projetaria um sistema que..."

Diretrizes:
- Seja ${pt(i, 'direto, analítico', 'direta, analítica')} e exigente — não aceite respostas superficiais sem aprofundar
- Faça follow-up se a resposta for vaga: "Pode detalhar mais como funciona X?"
- IMPORTANTE: Evite repetir temas ou estilos de pergunta já abordados na conversa
- Aumente progressivamente a dificuldade conforme o candidato responde bem
- Avalie raciocínio, profundidade técnica, clareza e experiência prática
- Responda sempre em português do Brasil`;
}

export function systemPromptEn(i: Interviewer = 'male'): string {
  return `${enIntro(i)}
${SPOKEN_RULES_EN}
- Ask exactly ONE question at a time. Never bundle two or three questions together.
${COMMON_RULES_EN}

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
}

/**
 * Evaluation prompt: the reply is spoken right before the next question (which
 * is generated separately), so it must never ask anything itself.
 */
export function evaluationSystemPromptPt(i: Interviewer = 'male'): string {
  return `${ptIntro(i)}
Neste momento você está APENAS comentando a resposta que o candidato acabou de dar. A próxima pergunta será feita depois, separadamente.
${SPOKEN_RULES_PT}
- NUNCA faça perguntas, nem mesmo retóricas. Não use ponto de interrogação.
- Termine sempre com um ponto final.
${COMMON_RULES_PT}

Diretrizes:
- Seja ${pt(i, 'direto, honesto', 'direta, honesta')} e específico sobre o que a resposta trouxe ou deixou de fora
- Não elogie demais uma resposta fraca
- Avalie raciocínio, profundidade técnica, clareza e experiência prática
- Responda sempre em português do Brasil`;
}

export function evaluationSystemPromptEn(i: Interviewer = 'male'): string {
  return `${enIntro(i)}
Right now you are ONLY commenting on the answer the candidate just gave. The next question will be asked afterwards, separately.
${SPOKEN_RULES_EN}
- NEVER ask any question, not even a rhetorical one. Do not use a question mark.
- Always end with a period.
${COMMON_RULES_EN}

Guidelines:
- Be direct, honest, and specific about what the answer covered or left out
- Do not over-praise a weak answer
- Evaluate reasoning, technical depth, clarity, and practical experience
- Always respond in English`;
}

// ─── Question Progressions ───────────────────────────────────────────────────
// Each level has 3 variant tracks so the same candidate gets different questions
// across sessions. Variant is randomly assigned at interview creation.
// Hints are TOPICS, never ready-made questions: the model phrases exactly one
// question from them (bundled "X? Y?" hints made it ask two or three at once).

// variant 1 → implementação / algoritmos / resolução verbal de problemas
// variant 2 → arquitetura / design / decisões
// variant 3 → performance / banco de dados / escalabilidade

export const PROGRESSION_PT: Record<string, Record<number, string[]>> = {
  junior: {
    1: [
      'apresentação: background e motivação para entrar na área de tecnologia',
      'fundamentos da linguagem da vaga: tipos, escopos e paradigma (OOP ou funcional)',
      'estruturas de dados: arrays vs listas encadeadas, diferenças e quando usar cada uma',
      'algoritmos: complexidade Big-O, com a análise da complexidade de um algoritmo que o candidato conheça',
      'resolução verbal: descreva um problema algorítmico simples, de nível júnior, em uma frase e peça a abordagem em voz alta, sem código',
      'algoritmos de busca e ordenação: como o candidato entende busca eficiente em coleções',
      'qualidade de código: o que torna um código limpo e de fácil manutenção',
      'testes: a abordagem do candidato para testes unitários e a experiência com TDD',
      'debugging: o processo do candidato diante de um bug difícil de reproduzir',
      'evolução: a área técnica que o candidato quer aprofundar nos próximos meses e o motivo',
    ],
    2: [
      'apresentação: o primeiro projeto ou experiência que despertou a vontade de ser desenvolvedor(a)',
      'fundamentos: gerenciamento de memória na linguagem da vaga, como funciona e quais os riscos',
      'estruturas de dados: hash maps, funcionamento interno e complexidade das operações',
      'algoritmos: recursão vs iteração, prós, contras e quando escolher cada abordagem',
      'resolução verbal: descreva um problema simples de manipulação de dados em uma frase e peça a abordagem em voz alta, sem código',
      'orientação a objetos: herança, polimorfismo e encapsulamento com exemplos práticos',
      'padrões de projeto: um padrão que o candidato já usou e o motivo da escolha',
      'tratamento de erros: como o candidato lida com erros e exceções no código',
      'versionamento: fluxo de trabalho com Git em equipe (branches, PRs, code review)',
      'aprendizado: como o candidato aprende uma nova tecnologia ou framework',
    ],
    3: [
      'apresentação: um projeto pessoal do qual o candidato se orgulha, o que faz e como foi construído',
      'fundamentos: semântica de comparação e igualdade na linguagem da vaga, com um exemplo real que já causou bug',
      'estruturas de dados: pilhas e filas, com um caso de uso real para cada uma',
      'algoritmos: memoização, o que é e quando aplicar, com um exemplo concreto',
      'resolução verbal: descreva um problema simples de iteração ou lógica condicional em uma frase e peça a abordagem em voz alta, passo a passo, sem código',
      'performance básica: como o candidato abordaria a otimização de um trecho de código lento',
      'colaboração: uma divergência técnica em equipe e como ela foi resolvida',
      'testes: os tipos de teste que existem e o que cada um verifica',
      'debugging: o bug mais difícil que o candidato já corrigiu e como chegou à causa raiz',
      'encerramento: o que o candidato faria diferente em um projeto anterior com o conhecimento de hoje',
    ],
  },
  mid: {
    1: [
      'apresentação: a área técnica mais forte do candidato e um projeto que a demonstra',
      'linguagem: generics, closures ou metaprogramação, como e quando o candidato os usa',
      'estruturas de dados: árvores e grafos, DFS vs BFS com análise de complexidade',
      'algoritmos: programação dinâmica, com um exemplo concreto que o candidato já usou',
      'resolução verbal: descreva um problema de complexidade média em uma frase e peça a abordagem em voz alta, com estrutura de dados e complexidade, sem código',
      'performance de aplicação: como o candidato perfila e identifica gargalos, e as ferramentas que usa',
      'banco de dados: otimização de queries, índices, EXPLAIN ANALYZE e o problema N+1',
      'princípios SOLID: um exemplo real de aplicação em código de produção',
      'testes: testes de integração vs unitários, quando usar cada um e o que cada tipo garante',
      'encerramento: a refatoração ou melhoria técnica de que o candidato mais se orgulha, a motivação e o impacto',
    ],
    2: [
      'apresentação: um sistema que o candidato projetou ou no qual contribuiu significativamente',
      'padrões de projeto: factory, observer e strategy em cenários reais de uso',
      'estruturas de dados: heap vs array ordenado e quando escolher cada um',
      'concorrência: threads, coroutines ou async/await e os trade-offs de cada abordagem',
      'resolução verbal: descreva um domínio de negócio em uma frase e peça em voz alta, sem código, como o candidato modelaria as entidades e abstrações',
      'arquitetura: monolito vs microsserviços e o que guiou a última decisão arquitetural de que o candidato participou',
      'banco de dados: normalização vs desnormalização e quando cada uma faz sentido',
      'design de API: REST vs GraphQL, trade-offs de design e manutenção',
      'cache: estratégias LRU, write-through e write-back e quando aplicar cada uma',
      'encerramento: uma dívida técnica que o candidato endereçou, como identificou, priorizou e executou',
    ],
    3: [
      'apresentação: um desafio de performance que o candidato resolveu, com contexto, causa raiz e solução',
      'linguagem: gerenciamento de memória, garbage collector e vazamentos na linguagem principal do candidato',
      'estruturas de dados: trie vs hash map para busca em texto',
      'algoritmos: complexidade amortizada, com um exemplo real em que ela importa',
      'resolução verbal: descreva uma função ineficiente em uma frase e peça em voz alta, sem código, como o candidato a otimizaria e a complexidade antes e depois',
      'banco de dados: tipos de índice (B-tree, hash, composto, parcial) e quando usar cada um',
      'banco de dados: leitura de um plano de execução (EXPLAIN) e os principais sinais de alerta',
      'performance: identificação de gargalos em produção, com as métricas e ferramentas usadas',
      'concorrência: race conditions e deadlocks, prevenção e detecção',
      'encerramento: o maior ganho de performance que o candidato já entregou e como o resultado foi medido',
    ],
  },
  senior: {
    1: [
      'apresentação: a contribuição técnica de maior impacto na carreira do candidato e o resultado obtido',
      'linguagem: internals avançados, como event loop, ajuste de GC ou compilação JIT, conforme a stack',
      'algoritmos: problemas NP-difíceis em produção e como abordá-los na prática',
      'resolução verbal: descreva em uma frase um problema complexo com várias abordagens válidas e peça em voz alta, sem código, a comparação dos trade-offs',
      'banco de dados: indexação avançada, índices parciais, covering indexes e index-only scans',
      'performance em escala: sharding, read replicas e connection pooling, quando e por que usar cada estratégia',
      'system design: um rate limiter distribuído para 100 mil requisições por segundo',
      'sistemas distribuídos: teorema CAP e decisões de consistência em produção',
      'confiabilidade: circuit breakers, bulkhead e chaos engineering aplicados na prática',
      'encerramento: como avaliar se um sistema está pronto para dez vezes mais tráfego',
    ],
    2: [
      'apresentação: uma decisão técnica estratégica que o candidato liderou do início ao fim, impacto e aprendizados',
      'arquitetura: event sourcing e CQRS, quando adotar e quais as armadilhas',
      'dados: persistência poliglota e a escolha do banco certo para cada workload',
      'system design: um sistema de notificações que processe 1 milhão de eventos por segundo',
      'liderança técnica: condução de revisões arquiteturais e garantia de padrões de engenharia no time',
      'sistemas distribuídos: consistência eventual e como raciocinar sobre e testar comportamentos assíncronos',
      'performance: identificação e resolução de falhas em cascata em microsserviços',
      'observabilidade: um stack de observabilidade pronto para produção, com logs, métricas e traces',
      'gestão de time: mentoria e aumento da velocidade do time sem criar dependência',
      'encerramento: uma divergência com stakeholders sobre uma decisão técnica e como ela foi conduzida',
    ],
    3: [
      'apresentação: um desafio de escalabilidade resolvido do zero, com a arquitetura antes e depois',
      'banco de dados: write amplification, LSM trees vs B-trees e os workloads em que cada um se destaca',
      'cache: cache stampede, estratégias de invalidação e CDN para alta disponibilidade',
      'performance: regressões de plano de query em produção, detecção e prevenção',
      'resolução verbal: descreva em uma frase a necessidade de um cache distribuído e peça em voz alta, sem código, o desenho da solução e os edge cases',
      'deploy: zero-downtime deployments com blue/green, canary e feature flags, e os trade-offs de cada estratégia',
      'sistemas distribuídos: transações distribuídas, 2PC vs padrão Saga e quando usar cada um',
      'segurança: OWASP em escala, injeção, autenticação e gestão de segredos em CI/CD',
      'incident response: condução de um post-mortem eficaz e prevenção de recorrência',
      'encerramento: como influenciar a cultura de engenharia de uma organização a longo prazo',
    ],
  },
};

export const PROGRESSION_EN: Record<string, Record<number, string[]>> = {
  junior: {
    1: [
      'introduction: background and what motivated the candidate to get into software engineering',
      'language fundamentals: type system, scopes, and the core paradigm (OOP or functional) of their stack',
      'data structures: arrays vs linked lists, their differences and when to use each',
      'algorithms: Big-O complexity, analyzing the complexity of an algorithm the candidate knows',
      'verbal problem solving: describe a simple junior-level algorithmic problem in one sentence and ask for the approach out loud, no code',
      'algorithms: efficient search in collections and how the candidate thinks about finding elements',
      'code quality: what makes code clean and easy to maintain',
      'testing: the candidate\'s approach to unit testing and any experience with TDD',
      'debugging: the candidate\'s process when dealing with a bug that is hard to reproduce',
      'growth: the technical area the candidate wants to deepen in the next few months and why',
    ],
    2: [
      'introduction: the first project or experience that made the candidate want to be a developer',
      'language internals: memory management in their primary language, how it works and what can go wrong',
      'data structures: hash maps, their internal mechanics and the complexity of operations',
      'algorithms: recursion vs iteration, pros, cons, and when to choose each',
      'verbal problem solving: describe a simple data manipulation problem in one sentence and ask for the approach out loud, no code',
      'OOP: inheritance, polymorphism, and encapsulation with practical examples',
      'design patterns: a pattern the candidate has used and why they chose it',
      'error handling: how the candidate handles errors and exceptions in their code',
      'version control: Git workflow in a team setting (branches, PRs, code review)',
      'learning: how the candidate approaches picking up a new technology or framework',
    ],
    3: [
      'introduction: a personal project the candidate is proud of, what it does and how it was built',
      'language: equality and comparison semantics in their language, with a real example that once caused a bug',
      'data structures: stacks and queues, with a real-world use case for each',
      'algorithms: memoization, what it is and when to apply it, with a concrete example',
      'verbal problem solving: describe a simple iteration or conditional logic problem in one sentence and ask for the approach out loud, step by step, no code',
      'performance basics: how the candidate would approach optimizing a slow block of code',
      'collaboration: a technical disagreement in a team and how it was resolved',
      'testing: the types of tests that exist and what each one verifies',
      'debugging: the hardest bug the candidate has fixed and how they found the root cause',
      'closing: what the candidate would do differently in a past project with their current knowledge',
    ],
  },
  mid: {
    1: [
      'introduction: the candidate\'s strongest technical area and a project that demonstrates it',
      'language deep-dive: generics, closures, or metaprogramming, and how and when the candidate uses them',
      'data structures: trees and graphs, DFS vs BFS with complexity analysis',
      'algorithms: dynamic programming, with a concrete example the candidate has actually used',
      'verbal problem solving: describe a medium-complexity problem in one sentence and ask for the approach out loud, including data structure and complexity, no code',
      'application performance: how the candidate profiles and identifies bottlenecks, and the tools they use',
      'database: query optimization, indexes, EXPLAIN ANALYZE, and the N+1 problem',
      'SOLID principles: a real example of applying them in production code',
      'testing: integration tests vs unit tests, when to use each and what each type guarantees',
      'closing: the refactoring or technical improvement the candidate is most proud of, what drove it and its impact',
    ],
    2: [
      'introduction: a system the candidate designed or significantly contributed to',
      'design patterns: factory, observer, and strategy in real use cases',
      'data structures: a heap vs a sorted array and when to choose each',
      'concurrency: threads, coroutines, or async/await and the trade-offs of each approach',
      'verbal problem solving: describe a business domain in one sentence and ask out loud, no code, how the candidate would model its entities and abstractions',
      'architecture: monolith vs microservices and what drove the last architectural decision the candidate was part of',
      'database: normalization vs denormalization and when each makes sense',
      'API design: REST vs GraphQL, design and maintenance trade-offs',
      'caching: LRU, write-through, and write-back strategies and when to apply each',
      'closing: a technical debt the candidate addressed, how they identified, prioritized, and executed it',
    ],
    3: [
      'introduction: a performance challenge the candidate solved, with context, root cause, and solution',
      'language: memory management, garbage collection, and leaks in the candidate\'s primary language',
      'data structures: a trie vs a hash map for text search',
      'algorithms: amortized complexity, with a real example where it matters in practice',
      'verbal problem solving: describe an inefficient function in one sentence and ask out loud, no code, how the candidate would optimize it and the complexity before and after',
      'database: index types (B-tree, hash, composite, partial) and when to use each',
      'database: reading an execution plan (EXPLAIN) and the main warning signs',
      'performance: identifying bottlenecks in production, with the metrics and tools the candidate relies on',
      'concurrency: race conditions and deadlocks, prevention and detection',
      'closing: the biggest performance gain the candidate has delivered and how the result was measured',
    ],
  },
  senior: {
    1: [
      'introduction: the candidate\'s highest-impact technical contribution and its outcome',
      'language internals: event loop tuning, GC configuration, or JIT compilation behavior in their stack',
      'algorithms: NP-hard problems in production and how to handle them practically',
      'verbal problem solving: describe a complex problem with several valid approaches in one sentence and ask out loud, no code, for a comparison of the trade-offs',
      'database: advanced indexing, partial indexes, covering indexes, and index-only scans',
      'performance at scale: sharding, read replicas, and connection pooling, and when and why to use each strategy',
      'system design: a distributed rate limiter handling 100k requests per second',
      'distributed systems: the CAP theorem and consistency trade-offs in production',
      'reliability: circuit breakers, the bulkhead pattern, and chaos engineering in practice',
      'closing: evaluating whether a system is ready for ten times the traffic',
    ],
    2: [
      'introduction: a strategic technical decision the candidate owned end-to-end, its impact and lessons learned',
      'architecture: event sourcing and CQRS, when to adopt them and their pitfalls',
      'data: polyglot persistence and choosing the right database for each workload',
      'system design: a notification system that processes 1 million events per second',
      'tech lead: running architectural reviews and enforcing engineering standards across the team',
      'distributed systems: eventual consistency and how to reason about and test asynchronous behavior',
      'performance: identifying and resolving cascading failures in a microservices architecture',
      'observability: a production-ready observability stack with logs, metrics, and traces',
      'team impact: mentoring engineers and improving team velocity without creating dependency',
      'closing: a time the candidate pushed back on stakeholders on a technical decision and how it played out',
    ],
    3: [
      'introduction: a scaling challenge the candidate solved from scratch, with the architecture before and after',
      'database: write amplification, LSM trees vs B-trees, and the workloads where each excels',
      'caching: cache stampede, invalidation strategies, and CDN configuration for high availability',
      'performance: query plan regressions in production, detection and prevention',
      'verbal problem solving: describe the need for a distributed cache in one sentence and ask out loud, no code, for the design and its edge cases',
      'deployment: zero-downtime deployments with blue/green, canary, and feature flags, and the trade-offs of each',
      'distributed systems: distributed transactions, 2PC vs the Saga pattern, and when to use each',
      'security: OWASP at scale, injection, authentication, and secrets management in CI/CD pipelines',
      'incident response: running an effective post-mortem and preventing the problem from recurring',
      'closing: influencing engineering culture across an organization over the long term',
    ],
  },
};

export const VARIANT_FOCUS_PT: Record<number, string> = {
  1: 'Foco da sessão: implementação, algoritmos e resolução verbal de problemas, com o candidato explicando o raciocínio em voz alta e justificando as escolhas técnicas, sem escrever código.',
  2: 'Foco da sessão: arquitetura, padrões de projeto e system design, explorando decisões, trade-offs e os motivos por trás de cada escolha.',
  3: 'Foco da sessão: performance, otimização de queries, indexação e escalabilidade, investigando como o candidato mede e melhora a performance de sistemas reais.',
};

export const VARIANT_FOCUS_EN: Record<number, string> = {
  1: 'Session focus: implementation, algorithms, and verbal problem solving, with the candidate explaining their reasoning out loud and justifying technical choices, without writing code.',
  2: 'Session focus: architecture, design patterns, and system design, probing decisions, trade-offs, and the reasoning behind each choice.',
  3: 'Session focus: performance, query optimization, indexing, and scalability, exploring how the candidate measures and improves real system performance.',
};

// ─── Input Sanitization ──────────────────────────────────────────────────────

function sanitizeInput(value: string, maxLength = 200): string {
  return value.replace(/[<>"'`\\]/g, '').trim().slice(0, maxLength);
}

const SCORE_KEYS = ['technical', 'communication', 'confidence', 'clarity', 'overall'] as const;

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class AIService implements IAIService {
  private readonly logger = new Logger(AIService.name);
  private readonly ollamaUrl: string;
  private readonly model: string;

  constructor(private readonly configService: ConfigService) {
    this.ollamaUrl = this.configService.get('OLLAMA_URL', 'http://localhost:11434');
    this.model = this.configService.get('OLLAMA_MODEL', 'qwen2.5:7b');
  }

  async generateQuestion(input: GenerateQuestionInput): Promise<string> {
    const lang = input.language ?? 'pt';
    const level = input.experienceLevel ?? 'mid';
    const variant = input.sessionVariant ?? 1;
    const interviewer = input.interviewer ?? 'male';
    const persona = PERSONA_NAMES[interviewer];
    const candidateName = sanitizeInput(input.candidateName);
    const role = sanitizeInput(input.role);

    const systemPrompt = lang === 'en' ? systemPromptEn(interviewer) : systemPromptPt(interviewer);
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
Greet them warmly using exactly the name "${candidateName}", introduce yourself in one short sentence, and ask the first question about this topic: ${progressionHint}.
Keep it under 60 words and end with exactly one question, with a single question mark.
Example: "Hi ${candidateName}, I'm ${persona} and I'll be running your interview today. ..."
${variantFocus}
${visionContext}${cvContext}${topicsContext}`;
      } else {
        userPrompt = `O candidato se chama ${candidateName} e está aplicando para ${role} (nível: ${level}).
Cumprimente-o(a) de forma cordial usando exatamente o nome "${candidateName}", apresente-se em uma frase curta e faça a primeira pergunta sobre este tema: ${progressionHint}.
Use no máximo 60 palavras e termine com exatamente uma pergunta, com um único ponto de interrogação.
Exemplo: "Olá, ${candidateName}, eu sou ${pt(interviewer, 'o', 'a')} ${persona} e vou conduzir sua entrevista hoje. ..."
${variantFocus}
${visionContext}${cvContext}${topicsContext}`;
      }
    } else {
      // Written as prose on purpose: a "Label: x | Label: y" header gets echoed
      // back verbatim by small models.
      if (lang === 'en') {
        userPrompt = `You are interviewing ${candidateName} for the ${role} position at ${level} level, and this is question ${questionIndex + 1} of ${maxQuestions}.
The topic for this question is ${progressionHint}.
Ask the next question: more challenging than the previous one, on a different topic or angle from what was already covered.
${variantFocus}
${visionContext}${cvContext}${topicsContext}
Reply with exactly ONE short question that ends with a single question mark (under 45 words). A one-sentence scenario before it is fine. No greetings, no comments on the previous answer, and never two questions in a row.`;
      } else {
        userPrompt = `Você está entrevistando ${candidateName} para a vaga de ${role}, nível ${level}, e esta é a pergunta ${questionIndex + 1} de ${maxQuestions}.
O tema desta pergunta é ${progressionHint}.
Faça a próxima pergunta: mais desafiadora que a anterior, sobre um tema ou ângulo diferente do que já foi abordado.
${variantFocus}
${visionContext}${cvContext}${topicsContext}
Responda com exatamente UMA pergunta curta, terminando com um único ponto de interrogação (menos de 45 palavras). Pode haver uma frase de contexto antes dela. Sem cumprimentos, sem comentar a resposta anterior e nunca duas perguntas seguidas.`;
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

    return this.toSpokenReply(await this.chat(messages, { temperature: 0.7 }));
  }

  async evaluateAnswer(input: EvaluateAnswerInput): Promise<string> {
    const lang = input.language ?? 'pt';
    const interviewer = input.interviewer ?? 'male';
    const systemPrompt = lang === 'en' ? evaluationSystemPromptEn(interviewer) : evaluationSystemPromptPt(interviewer);
    const visionContext = this.buildVisionContext(input.visionMetrics, lang);

    let prompt: string;
    if (lang === 'en') {
      prompt = `The question asked was: "${input.question}"

The candidate answered: "${input.answer}"

${visionContext}

Reply to the candidate directly, as you would on a call: 1 or 2 short sentences (under 40 words) reacting to the answer with a specific, honest comment.
Talk TO the candidate ("you mentioned..."), never ABOUT them ("the candidate..."). Do not over-praise a weak answer.
Do NOT ask anything, not even a rhetorical question, and end with a period.`;
    } else {
      prompt = `A pergunta feita foi: "${input.question}"

O candidato respondeu: "${input.answer}"

${visionContext}

Responda diretamente ao candidato, como numa chamada: 1 ou 2 frases curtas (menos de 40 palavras) reagindo à resposta com um comentário específico e honesto.
Fale COM o candidato ("você mencionou..."), nunca SOBRE ele ("o candidato..."). Não elogie demais uma resposta fraca.
NÃO pergunte nada, nem mesmo de forma retórica, e termine com um ponto final.`;
    }

    const reply = this.toSpokenReply(await this.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ], { temperature: 0.5, numPredict: 160 }));
    return this.withoutTrailingQuestions(reply, lang);
  }

  /**
   * Safety net for spoken replies: models still occasionally wrap the text in
   * quotes, prefix a label ("Pergunta 3:") or add markdown despite the prompt.
   */
  private toSpokenReply(text: string): string {
    const unquote = (t: string) => t.replace(/^["“'‘]+|["”'’]+$/g, '').trim();
    const cleaned = unquote(unquote(toSpeechText(text))
      .replace(/^(?:(?:alex|sofia)\s*:\s*)?(?:pergunta|question|avalia[çc][ãa]o|evaluation|feedback|coment[áa]rio|comment|resposta|response)(?:\s+\d+)?\s*[:\-–—]\s*/i, ''));
    return cleaned || text.trim();
  }

  /**
   * Evaluations are spoken right before the next question, so a trailing
   * "Can you elaborate?" would leave the candidate with two questions. Drops
   * trailing question sentences and guarantees the reply ends with a period.
   */
  private withoutTrailingQuestions(text: string, lang: Language): string {
    const sentences = text.split(/(?<=[.!?…]["”’']?)\s+/).filter((s) => s.trim().length > 0);
    while (sentences.length > 0 && /\?["”’']?$/.test(sentences[sentences.length - 1].trim())) {
      sentences.pop();
    }
    if (sentences.length === 0) {
      return lang === 'en' ? 'Alright, let\'s move on.' : 'Certo, vamos seguir.';
    }
    const result = sentences.join(' ').trim();
    return /[.!…]["”’']?$/.test(result) ? result : `${result}.`;
  }

  async generateFeedback(input: GenerateFeedbackInput): Promise<InterviewFeedback> {
    const lang = input.language ?? 'pt';
    const interviewer = input.interviewer ?? 'male';
    const { conversationHistory, visionMetrics, role, candidateName, experienceLevel, sessionVariant } = input;

    const systemPrompt = lang === 'en' ? systemPromptEn(interviewer) : systemPromptPt(interviewer);
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
- ${variantFocus}

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
- ${variantFocus}

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
    // Transport AND parse errors propagate: the caller reports feedback_failed
    // and a retry regenerates, instead of persisting made-up 5/10 scores.
    const text = await this.chat(messages, { format: 'json', temperature: 0.4 });

    try {
      return this.normalizeFeedback(this.extractJson(text), lang);
    } catch (err) {
      this.logger.error(`Failed to parse feedback JSON: ${(err as Error).message} — raw: ${text.slice(0, 300)}`);
      throw new Error('Could not generate feedback from the AI response — please retry');
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

  private hasScores(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const obj = value as Record<string, unknown>;
    return SCORE_KEYS.some((k) => this.parseScore(obj[k]) !== null);
  }

  /**
   * Finds the object holding the scores — models sometimes nest them, e.g.
   * {"feedback": {...}} or {"scores": {...}, "summary": "..."}. Outer fields are
   * kept so a top-level summary/strengths still count. Throws when there are none.
   */
  private locateFeedback(raw: Record<string, unknown>, depth = 0): Record<string, unknown> {
    if (this.hasScores(raw)) return raw;
    if (depth < 3) {
      for (const value of Object.values(raw)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          try {
            return { ...raw, ...this.locateFeedback(value as Record<string, unknown>, depth + 1) };
          } catch {
            /* keep looking */
          }
        }
      }
    }
    throw new Error('No score fields in feedback response');
  }

  private normalizeFeedback(json: Record<string, unknown>, lang: Language): InterviewFeedback {
    const raw = this.locateFeedback(json);
    const technical = this.parseScore(raw.technical);
    const communication = this.parseScore(raw.communication);
    const confidence = this.parseScore(raw.confidence);
    const clarity = this.parseScore(raw.clarity);

    const known = [technical, communication, confidence, clarity].filter((v): v is number => v !== null);
    const overall = this.parseScore(raw.overall)
      ?? (known.length > 0 ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10) / 10 : null);

    // locateFeedback guarantees at least one score, so overall is never null here.
    // A missing category takes the overall score rather than an invented constant.
    const base = overall ?? 0;

    const summary = typeof raw.summary === 'string' && raw.summary.trim().length > 0
      ? raw.summary.trim()
      : this.fallbackSummary(lang);

    return {
      technical: technical ?? base,
      communication: communication ?? base,
      confidence: confidence ?? base,
      clarity: clarity ?? base,
      overall: base,
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
          // Ollama's default context (2-4k tokens) silently drops the oldest
          // messages — including the system prompt — in long sessions.
          options: {
            temperature: opts.temperature ?? 0.7,
            num_ctx: 8192,
            ...(opts.numPredict ? { num_predict: opts.numPredict } : {}),
          },
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (fetchErr) {
      this.logger.error(`[AI] fetch threw (network error): ${(fetchErr as Error).message}`);
      throw new AIUnavailableError(`Ollama unreachable: ${(fetchErr as Error).message}`);
    }

    this.logger.log(`[AI] Ollama responded with status: ${res.status}`);

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`[AI] Ollama ${res.status} POST ${url} — ${body}`);
      throw new AIUnavailableError(`Ollama error ${res.status}: ${body}`);
    }

    let data: OllamaChatResponse;
    try {
      data = (await res.json()) as OllamaChatResponse;
    } catch (err) {
      throw new AIUnavailableError(`Ollama returned an unreadable response: ${(err as Error).message}`);
    }
    if (data.error) {
      throw new AIUnavailableError(`Ollama error: ${data.error}`);
    }
    const content = data.message?.content?.trim();
    if (!content) {
      throw new AIUnavailableError('Ollama returned an empty response');
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
Use it only to adjust your tone (e.g. be more encouraging if stress is high); never mention these numbers.`;
    }
    return `
Métricas comportamentais do candidato (0-1):
- Contato visual: ${metrics.eye_contact.toFixed(2)}
- Nível de stress: ${metrics.stress_level.toFixed(2)}
- Confiança: ${metrics.confidence.toFixed(2)}
Use apenas para ajustar o tom (por exemplo, um tom mais acolhedor se o stress estiver alto); nunca mencione esses números.`;
  }

  private fallbackSummary(lang: Language = 'pt'): string {
    return lang === 'en'
      ? 'Could not generate detailed feedback.'
      : 'Não foi possível gerar feedback detalhado.';
  }
}
