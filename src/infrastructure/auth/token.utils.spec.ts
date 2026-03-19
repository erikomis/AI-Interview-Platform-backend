import { hashToken } from './token.utils';

describe('hashToken', () => {
  it('produces a 64-character hex SHA-256 hash', () => {
    const result = hashToken('test-token-value');
    expect(result).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(result)).toBe(true);
  });

  it('is deterministic — same input always yields same hash', () => {
    const token = 'my-super-secret-reset-token';
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashToken('token-a')).not.toBe(hashToken('token-b'));
  });

  it('hashes an empty string without throwing', () => {
    expect(() => hashToken('')).not.toThrow();
    expect(hashToken('')).toHaveLength(64);
  });

  it('matches the native createHash output for the same input', () => {
    const { createHash } = require('crypto') as typeof import('crypto');
    const expected = createHash('sha256').update('abc').digest('hex');
    expect(hashToken('abc')).toBe(expected);
  });
});
