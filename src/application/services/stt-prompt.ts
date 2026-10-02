import { Interview } from '../../domain/entities/interview.entity';

// Terms Whisper often mishears without context (e.g. "Redis" → "rede is")
const TECH_TERMS =
  'API, REST, GraphQL, backend, frontend, banco de dados, SQL, PostgreSQL, MySQL, MongoDB, Redis, cache, ' +
  'Docker, Kubernetes, microsserviços, Node.js, TypeScript, JavaScript, React, Next.js, NestJS, Java, Spring, ' +
  'Python, Django, Go, filas, RabbitMQ, Kafka, índices, query, deploy, CI/CD, AWS, escalabilidade, ' +
  'performance, latência, threads, async, testes unitários, Git, pull request, code review';

/**
 * Context for speech recognition: the role and the question being answered
 * make Whisper prefer the right technical words and spellings.
 */
export function buildSttPrompt(interview: Interview): string {
  const question = (interview.currentQuestion ?? '').slice(0, 300);
  return interview.language === 'en'
    ? `Technical job interview for a ${interview.role} position. Question: ${question} Terms: ${TECH_TERMS}.`
    : `Entrevista técnica para a vaga de ${interview.role}. Pergunta: ${question} Termos: ${TECH_TERMS}.`;
}
