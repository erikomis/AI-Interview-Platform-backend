import { UnauthorizedException } from '@nestjs/common';
import { RefreshTokenUseCase } from './refresh-token.use-case';
import { hashToken } from '../../../infrastructure/auth/token.utils';

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

const fakeUser = { id: 'user-abc', email: 'alice@test.com', name: 'Alice' };
const fakeStoredToken = {
  id: 'token-row-id',
  userId: fakeUser.id,
  tokenHash: hashToken('valid-raw-token'),
  revoked: false,
  expiresAt: new Date(Date.now() + 86400_000),
};

const makeDrizzle = (tokenRows: unknown[] = [fakeStoredToken], userRows: unknown[] = [fakeUser]) => ({
  db: {
    select: jest.fn()
      .mockReturnValueOnce(dbChain(tokenRows))
      .mockReturnValueOnce(dbChain(userRows)),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
  },
});

const makeTokenService = () => ({
  issueTokens: jest.fn().mockResolvedValue({
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
  }),
  revokeAllUserTokens: jest.fn().mockResolvedValue(undefined),
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('RefreshTokenUseCase', () => {
  it('rotates tokens on valid refresh token', async () => {
    const drizzle = makeDrizzle();
    const tokenService = makeTokenService();
    const sut = new RefreshTokenUseCase(drizzle as any, tokenService as any);

    const result = await sut.execute('user-abc', 'valid-raw-token');

    expect(result).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    expect(tokenService.issueTokens).toHaveBeenCalledWith('user-abc', 'alice@test.com', 'Alice');
  });

  it('revokes the old refresh token before issuing new tokens', async () => {
    const drizzle = makeDrizzle();
    const tokenService = makeTokenService();
    const sut = new RefreshTokenUseCase(drizzle as any, tokenService as any);

    await sut.execute('user-abc', 'valid-raw-token');

    // The update (revoke) must be called
    expect(drizzle.db.update).toHaveBeenCalled();
  });

  it('revokes ALL user tokens and throws on invalid token (reuse attack)', async () => {
    const drizzle = makeDrizzle([], [fakeUser]); // empty token rows = invalid token
    const tokenService = makeTokenService();
    const sut = new RefreshTokenUseCase(drizzle as any, tokenService as any);

    await expect(sut.execute('user-abc', 'invalid-token')).rejects.toThrow(UnauthorizedException);
    expect(tokenService.revokeAllUserTokens).toHaveBeenCalledWith('user-abc');
    expect(tokenService.issueTokens).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException when user row is missing', async () => {
    const drizzle = makeDrizzle([fakeStoredToken], []); // no user row
    const tokenService = makeTokenService();
    const sut = new RefreshTokenUseCase(drizzle as any, tokenService as any);

    await expect(sut.execute('user-abc', 'valid-raw-token')).rejects.toThrow(UnauthorizedException);
  });
});
