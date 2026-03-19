import { BadRequestException } from '@nestjs/common';
import { VerifyEmailUseCase } from './verify-email.use-case';

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

const USER_ID = 'user-abc';
const RAW_TOKEN = 'valid-raw-email-verify-token';

const makeDrizzle = () => ({
  db: {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
  },
});

const makeRedis = (storedUserId: string | null = USER_ID) => ({
  get: jest.fn().mockResolvedValue(storedUserId),
  del: jest.fn().mockResolvedValue(undefined),
  set: jest.fn().mockResolvedValue(undefined),
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('VerifyEmailUseCase', () => {
  it('marks the user email as verified in the database', async () => {
    const drizzle = makeDrizzle();
    const redis = makeRedis();
    const sut = new VerifyEmailUseCase(drizzle as any, redis as any);

    await sut.execute(RAW_TOKEN);

    expect(drizzle.db.update).toHaveBeenCalled();
  });

  it('deletes the verification token from Redis after use (single-use)', async () => {
    const redis = makeRedis();
    const sut = new VerifyEmailUseCase(makeDrizzle() as any, redis as any);

    await sut.execute(RAW_TOKEN);

    expect(redis.del).toHaveBeenCalledWith(
      expect.stringMatching(/^email:verify:/),
    );
  });

  it('throws BadRequestException for an invalid or expired token', async () => {
    const redis = makeRedis(null);
    const sut = new VerifyEmailUseCase(makeDrizzle() as any, redis as any);

    await expect(sut.execute('expired-token')).rejects.toThrow(BadRequestException);
    await expect(sut.execute('expired-token')).rejects.toThrow('Invalid or expired verification link');
  });

  it('looks up the token by its SHA-256 hash, not the raw value', async () => {
    const redis = makeRedis();
    const sut = new VerifyEmailUseCase(makeDrizzle() as any, redis as any);

    await sut.execute(RAW_TOKEN);

    const [[redisKey]] = (redis.get as jest.Mock).mock.calls as [string][];
    expect(redisKey).not.toContain(RAW_TOKEN);
    expect(redisKey).toMatch(/^email:verify:[0-9a-f]{64}$/);
  });

  it('does not update the DB when token is invalid', async () => {
    const drizzle = makeDrizzle();
    const redis = makeRedis(null);
    const sut = new VerifyEmailUseCase(drizzle as any, redis as any);

    await expect(sut.execute('bad-token')).rejects.toThrow();
    expect(drizzle.db.update).not.toHaveBeenCalled();
  });
});
