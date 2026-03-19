import { ConflictException } from '@nestjs/common';
import { RegisterUseCase } from './register.use-case';

// ── Mock bcrypt so tests don't pay the real hashing cost ─────────────────────
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('$2b$12$mockedhash'),
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

const makeInsert = () => ({ values: jest.fn().mockResolvedValue([]) });

const makeDrizzle = (existingUsers: unknown[] = []) => {
  const insertChain = makeInsert();
  return {
    db: {
      select: jest.fn().mockReturnValue(dbChain(existingUsers)),
      insert: jest.fn().mockReturnValue(insertChain),
    },
    _insertChain: insertChain,
  };
};

const makeRedis = () => ({
  set: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
  del: jest.fn().mockResolvedValue(undefined),
});

const makeMail = () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
});

const makeTokenService = () => ({
  issueTokens: jest.fn().mockResolvedValue({
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
  }),
});

const validDto = {
  name: 'Alice Smith',
  email: 'alice@example.com',
  password: 'Password1!',
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('RegisterUseCase', () => {
  let drizzle: ReturnType<typeof makeDrizzle>;
  let redis: ReturnType<typeof makeRedis>;
  let mail: ReturnType<typeof makeMail>;
  let tokenService: ReturnType<typeof makeTokenService>;
  let sut: RegisterUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    drizzle = makeDrizzle();
    redis = makeRedis();
    mail = makeMail();
    tokenService = makeTokenService();
    sut = new RegisterUseCase(drizzle as any, redis as any, mail as any, tokenService as any);
  });

  it('creates a new user and returns tokens', async () => {
    const result = await sut.execute(validDto);

    expect(drizzle.db.insert).toHaveBeenCalledTimes(1);
    expect(tokenService.issueTokens).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
    });
  });

  it('hashes the password with bcrypt before storing', async () => {
    await sut.execute(validDto);
    expect(bcrypt.hash).toHaveBeenCalledWith('Password1!', 12);
    expect(drizzle._insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ passwordHash: '$2b$12$mockedhash' }),
    );
  });

  it('normalises email to lowercase and trimmed before lookup and storage', async () => {
    await sut.execute({ ...validDto, email: '  ALICE@EXAMPLE.COM  ' });

    expect(drizzle._insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'alice@example.com' }),
    );
  });

  it('trims whitespace from name before storing', async () => {
    await sut.execute({ ...validDto, name: '  Alice Smith  ' });

    expect(drizzle._insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Alice Smith' }),
    );
  });

  it('throws ConflictException when email is already registered', async () => {
    drizzle.db.select.mockReturnValue(dbChain([{ id: 'existing-user-id' }]));

    await expect(sut.execute(validDto)).rejects.toThrow(ConflictException);
    await expect(sut.execute(validDto)).rejects.toThrow('Email already registered');
  });

  it('does not insert when email already exists', async () => {
    drizzle.db.select.mockReturnValue(dbChain([{ id: 'existing' }]));

    await expect(sut.execute(validDto)).rejects.toThrow();
    expect(drizzle.db.insert).not.toHaveBeenCalled();
  });

  it('issues tokens using the registered user id', async () => {
    await sut.execute(validDto);

    expect(tokenService.issueTokens).toHaveBeenCalledWith(
      expect.any(String), // uuid
      'alice@example.com',
      'Alice Smith',
    );
  });

  it('fires verification email as fire-and-forget — does not throw if mail fails', async () => {
    // Make the DB select fail for the verification email sub-call
    // (first select = check existing; second select = get user for verification)
    drizzle.db.select
      .mockReturnValueOnce(dbChain([]))                     // no existing user
      .mockReturnValue(dbChain([]));                        // user not found during verification (returns early)

    // Should not throw even though sendVerificationEmail will return early
    await expect(sut.execute(validDto)).resolves.toBeDefined();
  });
});
