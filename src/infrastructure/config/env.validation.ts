// ─── Boot-time environment validation ────────────────────────────────────────
// Passed to ConfigModule.forRoot({ validate }) so the app refuses to start with
// missing secrets instead of failing on the first login/refresh.

const REQUIRED_NON_EMPTY = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const;

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const missing = REQUIRED_NON_EMPTY.filter((key) => {
    const value = config[key];
    return typeof value !== 'string' || value.trim().length === 0;
  });

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return config;
}
