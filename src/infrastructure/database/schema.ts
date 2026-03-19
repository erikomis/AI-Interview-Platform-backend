import { pgTable, uuid, text, integer, real, timestamp, jsonb, boolean, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ─── Users ────────────────────────────────────────────────────────────────────
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  cvSummary: text('cv_summary'),
});

// ─── Refresh tokens (stored as SHA-256 hash for security) ─────────────────────
export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  revoked: boolean('revoked').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─── Interviews ───────────────────────────────────────────────────────────────
export const interviews = pgTable('interviews', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  role: text('role').notNull(),
  language: text('language').notNull().default('pt'),
  experienceLevel: text('experience_level').notNull().default('mid'),
  status: text('status').notNull().default('pending'),
  sessionVariant: integer('session_variant').notNull().default(1),
  maxQuestions: integer('max_questions').notNull().default(10),
  candidateName: text('candidate_name'),
  topicsCovered: jsonb('topics_covered').$type<string[]>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
});

// ─── Messages ─────────────────────────────────────────────────────────────────
export const messages = pgTable('messages', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  interviewId: uuid('interview_id')
    .references(() => interviews.id, { onDelete: 'cascade' })
    .notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─── Feedback ─────────────────────────────────────────────────────────────────
export const feedback = pgTable('feedback', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  interviewId: uuid('interview_id')
    .references(() => interviews.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  technical: real('technical').notNull(),
  communication: real('communication').notNull(),
  confidence: real('confidence').notNull(),
  clarity: real('clarity').notNull(),
  overall: real('overall').notNull(),
  summary: text('summary').notNull(),
  strengths: jsonb('strengths').$type<string[]>().notNull(),
  improvements: jsonb('improvements').$type<string[]>().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─── Inferred types ───────────────────────────────────────────────────────────
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type DbInterview = typeof interviews.$inferSelect;
export type NewInterview = typeof interviews.$inferInsert;
export type DbMessage = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type DbFeedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
