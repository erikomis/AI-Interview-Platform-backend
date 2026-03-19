import { UnauthorizedException } from '@nestjs/common';
import { LoginUseCase } from './login.use-case';

// ── Mock bcrypt ───────────────────────────────────────────────────────────────
jest.mock('bcrypt', () => ({
  hash: jest.fn(),
  compare: jest.fn().mockResolvedValue(true),
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

const fakeUser = {
  id: 'user-abc',
  name: 'Alice',
  email: 'alice@example.com',
  passwordHash: '$2b$12$mockedhash',
};

const makeDrizzle = (rows: unknown[] = [fakeUser]) => ({
  db: { select: jest.fn().mockReturnValue(dbChain(rows)) },
});

const makeTokenService = () => ({
  issueTokens: jest.fn().mockResolvedValue({
    accessToken: 'access-tkn',
    refreshToken: 'refresh-tkn',
  }),
});

const makeLoginAttempt = () => ({
  checkLockout: jest.fn().mockResolvedValue(undefined),
  recordFailedAttempt: jest.fn().mockResolvedValue(undefined),
  clearFailedAttempts: jest.fn().mockResolvedValue(undefined),
});

const IP = '127.0.0.1';
const dto = { email: 'alice@example.com', password: 'Password1!' };

// ── Tests ────────────────────────────────────────────────────────────────────

describe('LoginUseCase', () => {
  let drizzle: ReturnType<typeof makeDrizzle>;
  let tokenService: ReturnType<typeof makeTokenService>;
  let loginAttempt: ReturnType<typeof makeLoginAttempt>;
  let sut: LoginUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    drizzle = makeDrizzle();
    tokenService = makeTokenService();
    loginAttempt = makeLoginAttempt();
    sut = new LoginUseCase(drizzle as any, tokenService as any, loginAttempt as any);
  });

  it('returns tokens on successful login', async () => {
    const result = await sut.execute(dto, IP);

    expect(result).toEqual({ accessToken: 'access-tkn', refreshToken: 'refresh-tkn' });
  });

  it('checks lockout before querying the DB', async () => {
    await sut.execute(dto, IP);

    const lockoutCallOrder = loginAttempt.checkLockout.mock.invocationCallOrder[0];
    const dbCallOrder = drizzle.db.select.mock.invocationCallOrder[0];
    expect(lockoutCallOrder).toBeLessThan(dbCallOrder);
  });

  it('normalises email to lowercase/trimmed before lookup', async () => {
    await sut.execute({ ...dto, email: '  ALICE@EXAMPLE.COM  ' }, IP);

    expect(loginAttempt.checkLockout).toHaveBeenCalledWith('alice@example.com', IP);
  });

  it('clears failed attempts on successful login', async () => {
    await sut.execute(dto, IP);
    expect(loginAttempt.clearFailedAttempts).toHaveBeenCalledWith('alice@example.com', IP);
  });

  it('throws UnauthorizedException and records attempt on wrong password', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);

    await expect(sut.execute(dto, IP)).rejects.toThrow(UnauthorizedException);
    expect(loginAttempt.recordFailedAttempt).toHaveBeenCalledWith('alice@example.com', IP);
    expect(tokenService.issueTokens).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException when user is not found', async () => {
    drizzle.db.select.mockReturnValue(dbChain([]));

    await expect(sut.execute(dto, IP)).rejects.toThrow(UnauthorizedException);
    expect(loginAttempt.recordFailedAttempt).toHaveBeenCalled();
  });

  it('throws UnauthorizedException and does not record attempt when account is locked', async () => {
    loginAttempt.checkLockout.mockRejectedValue(
      new UnauthorizedException('Account temporarily locked. Try again in 15 minutes.'),
    );

    await expect(sut.execute(dto, IP)).rejects.toThrow('temporarily locked');
    expect(loginAttempt.recordFailedAttempt).not.toHaveBeenCalled();
    expect(drizzle.db.select).not.toHaveBeenCalled();
  });

  it('issues tokens with the user id from the database', async () => {
    await sut.execute(dto, IP);
    expect(tokenService.issueTokens).toHaveBeenCalledWith('user-abc', 'alice@example.com', 'Alice');
  });
});
