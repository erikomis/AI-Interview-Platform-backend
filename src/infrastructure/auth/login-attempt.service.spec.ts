import { UnauthorizedException } from '@nestjs/common';
import { LoginAttemptService } from './login-attempt.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeRedis = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
  exists: jest.fn().mockResolvedValue(false),
  ...overrides,
});

const EMAIL = 'user@test.com';
const IP = '127.0.0.1';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('LoginAttemptService', () => {
  // ── checkLockout ────────────────────────────────────────────────────────────

  describe('checkLockout()', () => {
    it('does not throw when no lockout key exists', async () => {
      const redis = makeRedis({ get: jest.fn().mockResolvedValue(null) });
      const sut = new LoginAttemptService(redis as any);

      await expect(sut.checkLockout(EMAIL, IP)).resolves.not.toThrow();
    });

    it('throws UnauthorizedException when lockout key is present', async () => {
      const redis = makeRedis({ get: jest.fn().mockResolvedValue('1') });
      const sut = new LoginAttemptService(redis as any);

      await expect(sut.checkLockout(EMAIL, IP)).rejects.toThrow(UnauthorizedException);
      await expect(sut.checkLockout(EMAIL, IP)).rejects.toThrow('temporarily locked');
    });

    it('checks the correct Redis key pattern', async () => {
      const redis = makeRedis();
      const sut = new LoginAttemptService(redis as any);
      await sut.checkLockout(EMAIL, IP);

      expect(redis.get).toHaveBeenCalledWith(`auth:lockout:${EMAIL}:${IP}`);
    });
  });

  // ── recordFailedAttempt ─────────────────────────────────────────────────────

  describe('recordFailedAttempt()', () => {
    it('increments attempt counter on first failure', async () => {
      const redis = makeRedis({ get: jest.fn().mockResolvedValue(null) });
      const sut = new LoginAttemptService(redis as any);
      await sut.recordFailedAttempt(EMAIL, IP);

      expect(redis.set).toHaveBeenCalledWith(
        `auth:attempts:${EMAIL}:${IP}`,
        '1',
        expect.any(Number),
      );
    });

    it('increments from existing count', async () => {
      const redis = makeRedis({ get: jest.fn().mockResolvedValue('3') });
      const sut = new LoginAttemptService(redis as any);
      await sut.recordFailedAttempt(EMAIL, IP);

      expect(redis.set).toHaveBeenCalledWith(
        `auth:attempts:${EMAIL}:${IP}`,
        '4',
        expect.any(Number),
      );
    });

    it('locks the account after 5 failed attempts', async () => {
      const redis = makeRedis({ get: jest.fn().mockResolvedValue('4') }); // next = 5
      const sut = new LoginAttemptService(redis as any);
      await sut.recordFailedAttempt(EMAIL, IP);

      // Should set lockout key with 15-minute TTL
      expect(redis.set).toHaveBeenCalledWith(
        `auth:lockout:${EMAIL}:${IP}`,
        '1',
        900, // 15 minutes
      );
      // And delete the attempts counter
      expect(redis.del).toHaveBeenCalledWith(`auth:attempts:${EMAIL}:${IP}`);
    });

    it('does NOT lock before reaching 5 attempts', async () => {
      const redis = makeRedis({ get: jest.fn().mockResolvedValue('3') }); // next = 4
      const sut = new LoginAttemptService(redis as any);
      await sut.recordFailedAttempt(EMAIL, IP);

      expect(redis.set).not.toHaveBeenCalledWith(
        `auth:lockout:${EMAIL}:${IP}`,
        expect.anything(),
        expect.anything(),
      );
    });
  });

  // ── clearFailedAttempts ─────────────────────────────────────────────────────

  describe('clearFailedAttempts()', () => {
    it('deletes both the attempts and lockout keys', async () => {
      const redis = makeRedis();
      const sut = new LoginAttemptService(redis as any);
      await sut.clearFailedAttempts(EMAIL, IP);

      expect(redis.del).toHaveBeenCalledWith(`auth:attempts:${EMAIL}:${IP}`);
      expect(redis.del).toHaveBeenCalledWith(`auth:lockout:${EMAIL}:${IP}`);
      expect(redis.del).toHaveBeenCalledTimes(2);
    });
  });
});
