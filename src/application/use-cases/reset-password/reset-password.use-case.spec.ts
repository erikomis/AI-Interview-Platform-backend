import { BadRequestException } from '@nestjs/common';
import { ResetPasswordUseCase } from './reset-password.use-case';

// ── Mock bcrypt ───────────────────────────────────────────────────────────────
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('$2b$12$newpasswordhash'),
  compare: jest.fn(),
}));
import * as bcrypt from 'bcrypt';

// ── Helpers ──────────────────────────────────────────────────────────────────

function dbChain(value: unknown): any {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_, prop) {
      if (prop === 'then') {
        return (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
          Promise.resolve(value).then(ok, fail);
      }
      return () => new Proxy({} as Record<string, unknown>, handler);
    },
  };
  return new Proxy({} as Record<string, unknown>, handler);
}

const RAW_TOKEN = 'valid-raw-reset-token';
const USER_ID = 'user-abc';

const makeDrizzle = () => ({
  db: {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
  },
});

const makeRedis = (storedUserId: string | null = USER_ID) => ({
  get: jest.fn().mockResolvedValue(storedUserId),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
});

const makeTokenService = () => ({
  revokeAllUserTokens: jest.fn().mockResolvedValue(undefined),
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ResetPasswordUseCase', () => {
  beforeEach(() => jest.clearAllMocks());

  const makeSut = (redis = makeRedis(), drizzle = makeDrizzle(), tokenService = makeTokenService()) =>
    new ResetPasswordUseCase(drizzle as any, redis as any, tokenService as any);

  it('updates the password hash in the database', async () => {
    const drizzle = makeDrizzle();
    const sut = makeSut(makeRedis(), drizzle);

    await sut.execute({ token: RAW_TOKEN, newPassword: 'NewPassword1!' });

    expect(bcrypt.hash).toHaveBeenCalledWith('NewPassword1!', 12);
    expect(drizzle.db.update).toHaveBeenCalled();
  });

  it('revokes all user sessions after password change', async () => {
    const tokenService = makeTokenService();
    const sut = makeSut(makeRedis(), makeDrizzle(), tokenService);

    await sut.execute({ token: RAW_TOKEN, newPassword: 'NewPassword1!' });

    expect(tokenService.revokeAllUserTokens).toHaveBeenCalledWith(USER_ID);
  });

  it('deletes the reset token from Redis after use (single-use)', async () => {
    const redis = makeRedis();
    const sut = makeSut(redis);

    await sut.execute({ token: RAW_TOKEN, newPassword: 'NewPassword1!' });

    expect(redis.del).toHaveBeenCalledWith(
      expect.stringMatching(/^password:reset:/),
    );
  });

  it('throws BadRequestException for an invalid or expired token', async () => {
    const redis = makeRedis(null); // no token in Redis
    const sut = makeSut(redis);

    await expect(sut.execute({ token: 'expired-token', newPassword: 'NewPassword1!' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(sut.execute({ token: 'expired-token', newPassword: 'NewPassword1!' })).rejects.toThrow(
      'Invalid or expired reset link',
    );
  });

  it('looks up the token by its SHA-256 hash, not the raw value', async () => {
    const redis = makeRedis();
    const sut = makeSut(redis);

    await sut.execute({ token: RAW_TOKEN, newPassword: 'NewPassword1!' });

    const [[redisKey]] = (redis.get as jest.Mock).mock.calls as [string][];
    // Key must not contain raw token
    expect(redisKey).not.toContain(RAW_TOKEN);
    // Key must match hash pattern
    expect(redisKey).toMatch(/^password:reset:[0-9a-f]{64}$/);
  });
});
