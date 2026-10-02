import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('returns the config when required secrets are present', () => {
    const cfg = { JWT_ACCESS_SECRET: 'a', JWT_REFRESH_SECRET: 'b', OTHER: 'x' };
    expect(validateEnv(cfg)).toBe(cfg);
  });

  it('throws listing every missing or blank secret', () => {
    expect(() => validateEnv({ JWT_ACCESS_SECRET: '   ' })).toThrow(
      /JWT_ACCESS_SECRET, JWT_REFRESH_SECRET/,
    );
  });
});
