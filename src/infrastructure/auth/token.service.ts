import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { eq, and, lt } from 'drizzle-orm';
import { DrizzleService } from '../database/drizzle.service';
import { refreshTokens } from '../database/schema';
import { hashToken } from './token.utils';
import { JwtPayload } from './strategies/jwt.strategy';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly drizzle: DrizzleService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async issueTokens(userId: string, email: string, name: string) {
    const payload: JwtPayload = { sub: userId, email, name };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: ACCESS_TOKEN_TTL,
    });

    const jti = randomBytes(16).toString('hex');
    const refreshToken = this.jwtService.sign(
      { sub: userId, email, name, jti },
      { secret: this.config.get<string>('JWT_REFRESH_SECRET'), expiresIn: '7d' },
    );
    const tokenHash = hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

    await this.drizzle.db.insert(refreshTokens).values({ userId, tokenHash, expiresAt });

    this.cleanupRevokedTokens(userId).catch(() => {});

    return { accessToken, refreshToken };
  }

  async revokeToken(userId: string, rawToken: string) {
    const tokenHash = hashToken(rawToken);
    await this.drizzle.db
      .update(refreshTokens)
      .set({ revoked: true, revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), eq(refreshTokens.tokenHash, tokenHash)));
  }

  async revokeAllUserTokens(userId: string) {
    await this.drizzle.db
      .update(refreshTokens)
      .set({ revoked: true, revokedAt: new Date() })
      // Leave already-revoked rows untouched so their original revokedAt is preserved
      .where(and(eq(refreshTokens.userId, userId), eq(refreshTokens.revoked, false)));
  }

  // Only purge rows past their expiry: revoked-but-unexpired rows must remain so a
  // replayed (stolen) refresh token is recognised as reuse rather than "unknown".
  private async cleanupRevokedTokens(userId: string) {
    await this.drizzle.db
      .delete(refreshTokens)
      .where(and(eq(refreshTokens.userId, userId), lt(refreshTokens.expiresAt, new Date())));
  }
}
