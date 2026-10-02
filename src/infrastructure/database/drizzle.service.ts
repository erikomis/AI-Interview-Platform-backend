import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type postgres from 'postgres';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const postgresClient = require('postgres');
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

@Injectable()
export class DrizzleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DrizzleService.name);
  private sql: postgres.Sql;
  db: PostgresJsDatabase<typeof schema>;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const url = this.config.get<string>('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/interviews');
    this.sql = postgresClient(url, { max: 10 });
    this.db = drizzle(this.sql, { schema });
    await this.createTablesIfNotExist();
    this.logger.log('PostgreSQL connected');
  }

  async onModuleDestroy() {
    await this.sql.end();
  }

  private async createTablesIfNotExist() {
    await this.sql`
      CREATE TABLE IF NOT EXISTS users (
        id              UUID PRIMARY KEY,
        name            TEXT NOT NULL,
        email           TEXT NOT NULL UNIQUE,
        password_hash   TEXT NOT NULL,
        email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash  TEXT NOT NULL UNIQUE,
        expires_at  TIMESTAMPTZ NOT NULL,
        revoked     BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS interviews (
        id                UUID PRIMARY KEY,
        user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role              TEXT NOT NULL,
        language          TEXT NOT NULL DEFAULT 'pt',
        experience_level  TEXT NOT NULL DEFAULT 'mid',
        status            TEXT NOT NULL DEFAULT 'pending',
        session_variant   INTEGER NOT NULL DEFAULT 1,
        max_questions     INTEGER NOT NULL DEFAULT 10,
        candidate_name    TEXT,
        topics_covered    JSONB,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at      TIMESTAMPTZ
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS messages (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        interview_id  UUID NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
        role          TEXT NOT NULL,
        content       TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS feedback (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        interview_id   UUID NOT NULL UNIQUE REFERENCES interviews(id) ON DELETE CASCADE,
        technical      REAL NOT NULL,
        communication  REAL NOT NULL,
        confidence     REAL NOT NULL,
        clarity        REAL NOT NULL,
        overall        REAL NOT NULL,
        summary        TEXT NOT NULL,
        strengths      JSONB NOT NULL,
        improvements   JSONB NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Migrations: add new columns to existing tables (safe no-op if already present).
    // Must run after every CREATE TABLE, or a fresh database fails on a missing relation.
    await this.sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE`;
    await this.sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS cv_summary TEXT`;
    await this.sql`ALTER TABLE interviews ADD COLUMN IF NOT EXISTS max_questions INTEGER NOT NULL DEFAULT 10`;
    await this.sql`ALTER TABLE interviews ADD COLUMN IF NOT EXISTS candidate_name TEXT`;
    await this.sql`ALTER TABLE interviews ADD COLUMN IF NOT EXISTS topics_covered JSONB`;
    await this.sql`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ`;

    this.logger.log('Database tables ready');
  }
}
