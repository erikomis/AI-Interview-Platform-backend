/**
 * Integration tests for the full authentication flow.
 * Spins up real PostgreSQL + Redis containers via Testcontainers.
 * Requires Docker running.  Run with: npm run test:integration
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as schema from '../database/schema';
import { RegisterUseCase } from '../../application/use-cases/register/register.use-case';
import { LoginUseCase } from '../../application/use-cases/login/login.use-case';
import { RefreshTokenUseCase } from '../../application/use-cases/refresh-token/refresh-token.use-case';
import { LogoutUseCase } from '../../application/use-cases/logout/logout.use-case';
import { LogoutAllUseCase } from '../../application/use-cases/logout-all/logout-all.use-case';
import { ForgotPasswordUseCase } from '../../application/use-cases/forgot-password/forgot-password.use-case';
import { ResetPasswordUseCase } from '../../application/use-cases/reset-password/reset-password.use-case';
import { VerifyEmailUseCase } from '../../application/use-cases/verify-email/verify-email.use-case';
import { LoginAttemptService } from './login-attempt.service';
import { TokenService } from './token.service';

// ── Schema ────────────────────────────────────────────────────────────────────

async function createSchema(sql: postgres.Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id              UUID PRIMARY KEY,
      name            TEXT NOT NULL,
      email           TEXT NOT NULL UNIQUE,
      password_hash   TEXT NOT NULL,
      email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
      cv_summary      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      revoked     BOOLEAN NOT NULL DEFAULT FALSE,
      revoked_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS interviews (
      id               UUID PRIMARY KEY,
      user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role             TEXT NOT NULL,
      language         TEXT NOT NULL DEFAULT 'pt',
      experience_level TEXT NOT NULL DEFAULT 'mid',
      status           TEXT NOT NULL DEFAULT 'pending',
      session_variant  INTEGER NOT NULL DEFAULT 1,
      max_questions    INTEGER NOT NULL DEFAULT 10,
      candidate_name   TEXT,
      topics_covered   JSONB,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at     TIMESTAMPTZ
    )
  `;
}

// ── Service factory helpers ───────────────────────────────────────────────────

const JWT_ACCESS_SECRET = 'test-access-secret-32chars-minimum';
const JWT_REFRESH_SECRET = 'test-refresh-secret-32chars-minim';

function makeFakeConfig(): ConfigService {
  return {
    get: (key: string) => {
      if (key === 'JWT_ACCESS_SECRET') return JWT_ACCESS_SECRET;
      if (key === 'JWT_REFRESH_SECRET') return JWT_REFRESH_SECRET;
      return undefined;
    },
  } as unknown as ConfigService;
}

function makeFakeDrizzle(db: PostgresJsDatabase<typeof schema>) {
  return { db } as any;
}

function makeFakeRedis(client: Redis) {
  return {
    set: async (key: string, value: string, ttl?: number) => {
      if (ttl) await client.set(key, value, 'EX', ttl);
      else await client.set(key, value);
    },
    get: (key: string) => client.get(key),
    del: (key: string) => client.del(key),
    exists: async (key: string) => (await client.exists(key)) === 1,
  } as any;
}

function makeFakeMail() {
  return {
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
    sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
    sendInterviewFeedback: jest.fn().mockResolvedValue(undefined),
  } as any;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Auth — full integration flow', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let sql: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let redisClient: Redis;

  // Use cases
  let registerUC: RegisterUseCase;
  let loginUC: LoginUseCase;
  let refreshTokenUC: RefreshTokenUseCase;
  let logoutUC: LogoutUseCase;
  let logoutAllUC: LogoutAllUseCase;
  let forgotPasswordUC: ForgotPasswordUseCase;
  let resetPasswordUC: ResetPasswordUseCase;
  let verifyEmailUC: VerifyEmailUseCase;
  let loginAttemptService: LoginAttemptService;
  let mailService: ReturnType<typeof makeFakeMail>;

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('test_auth')
        .withUsername('test')
        .withPassword('test')
        .start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);

    sql = postgres(pgContainer.getConnectionUri(), { max: 5 });
    db = drizzle(sql, { schema });
    await createSchema(sql);

    redisClient = new Redis({
      host: redisContainer.getHost(),
      port: redisContainer.getMappedPort(6379),
    });

    const fakeDrizzle = makeFakeDrizzle(db);
    const fakeRedis = makeFakeRedis(redisClient);
    const fakeConfig = makeFakeConfig();
    mailService = makeFakeMail();

    const jwtService = new JwtService({});
    const tokenService = new TokenService(fakeDrizzle, jwtService, fakeConfig);

    loginAttemptService = new LoginAttemptService(fakeRedis);

    registerUC = new RegisterUseCase(fakeDrizzle, fakeRedis, mailService, tokenService);
    loginUC = new LoginUseCase(fakeDrizzle, tokenService, loginAttemptService);
    refreshTokenUC = new RefreshTokenUseCase(fakeDrizzle, tokenService);
    logoutUC = new LogoutUseCase(tokenService);
    logoutAllUC = new LogoutAllUseCase(tokenService);
    forgotPasswordUC = new ForgotPasswordUseCase(fakeDrizzle, fakeRedis, mailService);
    resetPasswordUC = new ResetPasswordUseCase(fakeDrizzle, fakeRedis, tokenService);
    verifyEmailUC = new VerifyEmailUseCase(fakeDrizzle, fakeRedis);
  }, 120_000);

  afterAll(async () => {
    await redisClient.quit();
    await sql.end();
    await pgContainer.stop();
    await redisContainer.stop();
  });

  afterEach(async () => {
    await redisClient.flushdb();
    // Clean DB between tests
    await sql`DELETE FROM refresh_tokens`;
    await sql`DELETE FROM users`;
    jest.clearAllMocks();
  });

  // ── Register ──────────────────────────────────────────────────────────────

  describe('RegisterUseCase', () => {
    it('creates a user in the DB and returns token pair', async () => {
      const result = await registerUC.execute({
        name: 'Alice',
        email: 'alice@test.com',
        password: 'Password1!',
      });

      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();

      const users = await sql`SELECT * FROM users WHERE email = 'alice@test.com'`;
      expect(users).toHaveLength(1);
      expect(users[0].name).toBe('Alice');
      expect(users[0].password_hash).not.toBe('Password1!'); // must be hashed
    });

    it('stores a refresh token row in the DB', async () => {
      await registerUC.execute({ name: 'Bob', email: 'bob@test.com', password: 'Password1!' });

      const rows = await sql`SELECT * FROM refresh_tokens`;
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    it('throws ConflictException for duplicate email', async () => {
      await registerUC.execute({ name: 'Alice', email: 'dupe@test.com', password: 'Password1!' });

      const { ConflictException } = await import('@nestjs/common');
      await expect(
        registerUC.execute({ name: 'Alice2', email: 'dupe@test.com', password: 'Password1!' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── Login ────────────────────────────────────────────────────────────────

  describe('LoginUseCase', () => {
    beforeEach(async () => {
      await registerUC.execute({ name: 'Alice', email: 'alice@test.com', password: 'Password1!' });
    });

    it('returns tokens on valid credentials', async () => {
      const result = await loginUC.execute({ email: 'alice@test.com', password: 'Password1!' }, '127.0.0.1');

      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
    });

    it('throws UnauthorizedException on wrong password', async () => {
      const { UnauthorizedException } = await import('@nestjs/common');
      await expect(
        loginUC.execute({ email: 'alice@test.com', password: 'WrongPass1!' }, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException for unknown email', async () => {
      const { UnauthorizedException } = await import('@nestjs/common');
      await expect(
        loginUC.execute({ email: 'ghost@test.com', password: 'Password1!' }, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── Login lockout ────────────────────────────────────────────────────────

  describe('LoginAttemptService — lockout', () => {
    beforeEach(async () => {
      await registerUC.execute({ name: 'Alice', email: 'alice@test.com', password: 'Password1!' });
    });

    it('locks the account after 5 failed login attempts', async () => {
      const ip = '10.0.0.1';

      // 5 bad attempts
      for (let i = 0; i < 5; i++) {
        await loginUC.execute({ email: 'alice@test.com', password: 'Wrong!' }, ip).catch(() => {});
      }

      // 6th attempt should hit the lockout
      await expect(
        loginUC.execute({ email: 'alice@test.com', password: 'Password1!' }, ip),
      ).rejects.toThrow('temporarily locked');
    });
  });

  // ── Token rotation ───────────────────────────────────────────────────────

  describe('RefreshTokenUseCase', () => {
    it('issues a new token pair and revokes the old refresh token', async () => {
      const { refreshToken: oldRefresh } = await registerUC.execute({
        name: 'Bob',
        email: 'bob@test.com',
        password: 'Password1!',
      });

      const userRow = await sql`SELECT id FROM users WHERE email = 'bob@test.com'`;
      const userId = userRow[0].id as string;

      const result = await refreshTokenUC.execute(userId, oldRefresh);

      expect(result.accessToken).toBeTruthy();
      // refreshToken must be a new (different) raw token — access token may be same within same second
      expect(result.refreshToken).not.toBe(oldRefresh);

      // Old refresh token must be revoked
      const oldRow = await sql`SELECT revoked FROM refresh_tokens WHERE revoked = true`;
      expect(oldRow.length).toBeGreaterThanOrEqual(1);
    });

    it('revokes ALL sessions when a reused (invalid) refresh token is submitted', async () => {
      const { refreshToken } = await registerUC.execute({
        name: 'Eve',
        email: 'eve@test.com',
        password: 'Password1!',
      });

      const userRow = await sql`SELECT id FROM users WHERE email = 'eve@test.com'`;
      const userId = userRow[0].id as string;

      // First use — valid
      await refreshTokenUC.execute(userId, refreshToken);

      // Push the rotation outside the 30s grace window so the replay counts as an attack
      await sql`UPDATE refresh_tokens SET revoked_at = NOW() - INTERVAL '5 minutes' WHERE user_id = ${userId} AND revoked = true`;

      // Second use of the SAME token — reuse attack
      const { UnauthorizedException } = await import('@nestjs/common');
      await expect(
        refreshTokenUC.execute(userId, refreshToken),
      ).rejects.toThrow(UnauthorizedException);

      // All tokens for that user must be revoked
      const tokens = await sql`SELECT revoked FROM refresh_tokens WHERE user_id = ${userId}`;
      expect(tokens.every((t: Record<string, unknown>) => t.revoked)).toBe(true);
    });

    it('rejects a token replayed within the grace window WITHOUT revoking other sessions', async () => {
      const { refreshToken } = await registerUC.execute({
        name: 'Gina',
        email: 'gina@test.com',
        password: 'Password1!',
      });
      const userRow = await sql`SELECT id FROM users WHERE email = 'gina@test.com'`;
      const userId = userRow[0].id as string;

      await refreshTokenUC.execute(userId, refreshToken);

      const { UnauthorizedException } = await import('@nestjs/common');
      await expect(refreshTokenUC.execute(userId, refreshToken)).rejects.toThrow(UnauthorizedException);

      // The token issued by the first (winning) rotation is still valid
      const active = await sql`SELECT id FROM refresh_tokens WHERE user_id = ${userId} AND revoked = false`;
      expect(active.length).toBe(1);
    });
  });

  // ── Logout ───────────────────────────────────────────────────────────────

  describe('LogoutUseCase', () => {
    it('revokes the specific refresh token on logout', async () => {
      const { refreshToken } = await registerUC.execute({
        name: 'Carol',
        email: 'carol@test.com',
        password: 'Password1!',
      });
      const userRow = await sql`SELECT id FROM users WHERE email = 'carol@test.com'`;
      const userId = userRow[0].id as string;

      await logoutUC.execute(userId, refreshToken);

      const rows = await sql`SELECT revoked FROM refresh_tokens WHERE user_id = ${userId}`;
      expect(rows[0].revoked).toBe(true);
    });
  });

  describe('LogoutAllUseCase', () => {
    it('revokes all refresh tokens for the user', async () => {
      await registerUC.execute({
        name: 'Dan',
        email: 'dan@test.com',
        password: 'Password1!',
      });
      const userRow = await sql`SELECT id FROM users WHERE email = 'dan@test.com'`;
      const userId = userRow[0].id as string;

      await loginUC.execute({ email: 'dan@test.com', password: 'Password1!' }, '127.0.0.1');

      await logoutAllUC.execute(userId);

      const rows = await sql`SELECT revoked FROM refresh_tokens WHERE user_id = ${userId}`;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.every((r: Record<string, unknown>) => r.revoked)).toBe(true);
    });
  });

  // ── Forgot / Reset password ───────────────────────────────────────────────

  describe('ForgotPasswordUseCase + ResetPasswordUseCase', () => {
    it('full reset flow: forgot → Redis token → reset → login with new password', async () => {
      await registerUC.execute({ name: 'Frank', email: 'frank@test.com', password: 'OldPass1!' });

      // 1. Forgot password — stores token in Redis, sends email
      await forgotPasswordUC.execute({ email: 'frank@test.com' });

      expect(mailService.sendPasswordResetEmail).toHaveBeenCalledWith(
        'frank@test.com',
        'Frank',
        expect.any(String),
      );

      const [[, , rawToken]] = (mailService.sendPasswordResetEmail as jest.Mock).mock.calls as [string, string, string][];

      // 2. Reset password with the raw token from the email
      const userRow = await sql`SELECT id FROM users WHERE email = 'frank@test.com'`;
      const userId = userRow[0].id as string;

      await resetPasswordUC.execute({ token: rawToken, newPassword: 'NewPass1!' });

      // 3. Old sessions must be revoked
      const tokenRows = await sql`SELECT revoked FROM refresh_tokens WHERE user_id = ${userId}`;
      expect(tokenRows.every((r: Record<string, unknown>) => r.revoked)).toBe(true);

      // 4. Redis reset key must be deleted
      const { hashToken } = await import('./token.utils');
      const tokenHash = hashToken(rawToken);
      expect(await redisClient.get(`password:reset:${tokenHash}`)).toBeNull();

      // 5. Can login with new password
      const result = await loginUC.execute({ email: 'frank@test.com', password: 'NewPass1!' }, '127.0.0.1');
      expect(result.accessToken).toBeTruthy();
    });

    it('silently ignores unknown email (no enumeration)', async () => {
      await expect(
        forgotPasswordUC.execute({ email: 'nobody@test.com' }),
      ).resolves.toBeUndefined();
      expect(mailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for expired or invalid reset token', async () => {
      const { BadRequestException } = await import('@nestjs/common');
      await expect(
        resetPasswordUC.execute({ token: 'fake-token-xyz', newPassword: 'NewPass1!' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── Email verification ───────────────────────────────────────────────────

  describe('VerifyEmailUseCase', () => {
    it('marks the user as email-verified after a valid token', async () => {
      await registerUC.execute({ name: 'Grace', email: 'grace@test.com', password: 'Password1!' });

      const userRow = await sql`SELECT id FROM users WHERE email = 'grace@test.com'`;
      const userId = userRow[0].id as string;

      // Simulate storing a verification token (as register.use-case does internally)
      const { randomBytes } = await import('crypto');
      const { hashToken } = await import('./token.utils');
      const rawToken = randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      await redisClient.set(`email:verify:${tokenHash}`, userId, 'EX', 86400);

      await verifyEmailUC.execute(rawToken);

      const [updated] = await sql`SELECT email_verified FROM users WHERE id = ${userId}`;
      expect(updated.email_verified).toBe(true);

      // Token must be consumed
      expect(await redisClient.get(`email:verify:${tokenHash}`)).toBeNull();
    });

    it('throws BadRequestException for an invalid verification token', async () => {
      const { BadRequestException } = await import('@nestjs/common');
      await expect(verifyEmailUC.execute('invalid-verify-token')).rejects.toThrow(BadRequestException);
    });
  });
});
