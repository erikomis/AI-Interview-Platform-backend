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

const makeDrizzle = (
  tokenRows: unknown[] = [fakeStoredToken],
  userRows: unknown[] = [fakeUser],
  rotatedRows: unknown[] = [{ id: fakeStoredToken.id }],
) => ({
  db: {
    select: jest.fn()
      .mockReturnValueOnce(dbChain(tokenRows))
      .mockReturnValueOnce(dbChain(userRows)),
    // UPDATE ... WHERE id = ? AND revoked = false RETURNING id
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(rotatedRows),
        }),
      }),
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

  it('throws on unknown token without revoking other sessions', async () => {
    const drizzle = makeDrizzle([], [fakeUser]); // empty token rows = unknown token
    const tokenService = makeTokenService();
    const sut = new RefreshTokenUseCase(drizzle as any, tokenService as any);

    await expect(sut.execute('user-abc', 'invalid-token')).rejects.toThrow(UnauthorizedException);
    expect(tokenService.revokeAllUserTokens).not.toHaveBeenCalled();
    expect(tokenService.issueTokens).not.toHaveBeenCalled();
  });

  it('revokes ALL user tokens and throws when a revoked token is reused (reuse attack)', async () => {
    const revokedLongAgo = new Date(Date.now() - 5 * 60_000);
    const drizzle = makeDrizzle([{ ...fakeStoredToken, revoked: true, revokedAt: revokedLongAgo }], [fakeUser]);
    const tokenService = makeTokenService();
    const sut = new RefreshTokenUseCase(drizzle as any, tokenService as any);

    await expect(sut.execute('user-abc', 'valid-raw-token')).rejects.toThrow(UnauthorizedException);
    expect(tokenService.revokeAllUserTokens).toHaveBeenCalledWith('user-abc');
    expect(tokenService.issueTokens).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException when user row is missing', async () => {
    const drizzle = makeDrizzle([fakeStoredToken], []); // no user row
    const tokenService = makeTokenService();
    const sut = new RefreshTokenUseCase(drizzle as any, tokenService as any);

    await expect(sut.execute('user-abc', 'valid-raw-token')).rejects.toThrow(UnauthorizedException);
  });

  it('treats a legacy revoked token without revokedAt as reuse', async () => {
    const drizzle = makeDrizzle([{ ...fakeStoredToken, revoked: true, revokedAt: null }], [fakeUser]);
    const tokenService = makeTokenService();
    const sut = new RefreshTokenUseCase(drizzle as any, tokenService as any);

    await expect(sut.execute('user-abc', 'valid-raw-token')).rejects.toThrow(UnauthorizedException);
    expect(tokenService.revokeAllUserTokens).toHaveBeenCalledWith('user-abc');
  });

  it('rejects WITHOUT revoking all sessions when the token was rotated within the grace window', async () => {
    const justNow = new Date(Date.now() - 5_000);
    const drizzle = makeDrizzle([{ ...fakeStoredToken, revoked: true, revokedAt: justNow }], [fakeUser]);
    const tokenService = makeTokenService();
    const sut = new RefreshTokenUseCase(drizzle as any, tokenService as any);

    await expect(sut.execute('user-abc', 'valid-raw-token')).rejects.toThrow(UnauthorizedException);
    expect(tokenService.revokeAllUserTokens).not.toHaveBeenCalled();
    expect(tokenService.issueTokens).not.toHaveBeenCalled();
  });

  it('rejects the loser of a concurrent rotation (atomic UPDATE matched no row)', async () => {
    const drizzle = makeDrizzle([fakeStoredToken], [fakeUser], []);
    const tokenService = makeTokenService();
    const sut = new RefreshTokenUseCase(drizzle as any, tokenService as any);

    await expect(sut.execute('user-abc', 'valid-raw-token')).rejects.toThrow(UnauthorizedException);
    expect(tokenService.revokeAllUserTokens).not.toHaveBeenCalled();
    expect(tokenService.issueTokens).not.toHaveBeenCalled();
  });

  it('rejects an expired (non-revoked) token', async () => {
    const drizzle = makeDrizzle([{ ...fakeStoredToken, expiresAt: new Date(Date.now() - 1000) }]);
    const tokenService = makeTokenService();
    const sut = new RefreshTokenUseCase(drizzle as any, tokenService as any);

    await expect(sut.execute('user-abc', 'valid-raw-token')).rejects.toThrow(UnauthorizedException);
    expect(drizzle.db.update).not.toHaveBeenCalled();
  });
});
