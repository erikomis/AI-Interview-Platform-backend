import { ForgotPasswordUseCase } from './forgot-password.use-case';

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

const fakeUser = { id: 'user-abc', name: 'Alice' };

const makeDrizzle = (rows: unknown[] = [fakeUser]) => ({
  db: { select: jest.fn().mockReturnValue(dbChain(rows)) },
});

const makeRedis = () => ({
  set: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
  del: jest.fn().mockResolvedValue(undefined),
});

const makeMail = () => ({
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ForgotPasswordUseCase', () => {
  let drizzle: ReturnType<typeof makeDrizzle>;
  let redis: ReturnType<typeof makeRedis>;
  let mail: ReturnType<typeof makeMail>;
  let sut: ForgotPasswordUseCase;

  beforeEach(() => {
    drizzle = makeDrizzle();
    redis = makeRedis();
    mail = makeMail();
    sut = new ForgotPasswordUseCase(drizzle as any, redis as any, mail as any);
  });

  it('stores a hashed reset token in Redis with 1-hour TTL', async () => {
    await sut.execute({ email: 'alice@example.com' });

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^password:reset:/),
      fakeUser.id,
      3600,
    );
  });

  it('sends the password reset email with the raw (unhashed) token', async () => {
    await sut.execute({ email: 'alice@example.com' });

    expect(mail.sendPasswordResetEmail).toHaveBeenCalledWith(
      'alice@example.com',
      fakeUser.name,
      expect.any(String), // raw token
    );
  });

  it('normalises email to lowercase before lookup', async () => {
    await sut.execute({ email: '  ALICE@EXAMPLE.COM  ' });

    // The email sent to mail service should be normalised
    expect(mail.sendPasswordResetEmail).toHaveBeenCalledWith(
      'alice@example.com',
      expect.any(String),
      expect.any(String),
    );
  });

  it('silently returns without sending email when user is not found (no enumeration)', async () => {
    drizzle.db.select.mockReturnValue(dbChain([]));

    await expect(sut.execute({ email: 'unknown@example.com' })).resolves.toBeUndefined();
    expect(redis.set).not.toHaveBeenCalled();
    expect(mail.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('the reset token stored in Redis is the SHA-256 hash, not the raw token', async () => {
    await sut.execute({ email: 'alice@example.com' });

    const [[redisKey, , ]] = (redis.set as jest.Mock).mock.calls as [string, string, number][];
    const [[, , rawToken]] = (mail.sendPasswordResetEmail as jest.Mock).mock.calls as [string, string, string][];

    // The key should NOT contain the raw token directly
    expect(redisKey).not.toContain(rawToken);
    // The key should have the hashed form
    expect(redisKey).toMatch(/^password:reset:[0-9a-f]{64}$/);
  });
});
