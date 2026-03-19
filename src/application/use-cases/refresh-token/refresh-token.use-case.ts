import { Injectable, UnauthorizedException } from '@nestjs/common';
import { eq, and, gt } from 'drizzle-orm';
import { DrizzleService } from '../../../infrastructure/database/drizzle.service';
import { TokenService } from '../../../infrastructure/auth/token.service';
import { hashToken } from '../../../infrastructure/auth/token.utils';
import { users, refreshTokens } from '../../../infrastructure/database/schema';

@Injectable()
export class RefreshTokenUseCase {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly tokenService: TokenService,
  ) {}

  async execute(userId: string, rawToken: string) {
    const tokenHash = hashToken(rawToken);

    // Look up the token regardless of revoked status to detect reuse attacks
    const anyMatch = await this.drizzle.db
      .select()
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.tokenHash, tokenHash),
        ),
      )
      .limit(1);

    if (anyMatch.length > 0 && anyMatch[0].revoked) {
      // Token was already used — genuine reuse attack, revoke everything
      await this.tokenService.revokeAllUserTokens(userId);
      throw new UnauthorizedException('Token reuse detected');
    }

    const stored = anyMatch.filter(
      (t) => !t.revoked && t.expiresAt > new Date(),
    );

    if (stored.length === 0) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Rotate: revoke used token, issue new pair
    await this.drizzle.db
      .update(refreshTokens)
      .set({ revoked: true })
      .where(eq(refreshTokens.id, stored[0].id));

    const user = await this.drizzle.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (user.length === 0) throw new UnauthorizedException();

    return this.tokenService.issueTokens(user[0].id, user[0].email, user[0].name);
  }
}
