import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DrizzleService } from '../../../infrastructure/database/drizzle.service';
import { TokenService } from '../../../infrastructure/auth/token.service';
import { hashToken } from '../../../infrastructure/auth/token.utils';
import { users, refreshTokens } from '../../../infrastructure/database/schema';

// A revoked token presented again within this window is treated as a benign
// race (two tabs / a retried request refreshing concurrently), not as theft.
// The loser gets 409 (not 401): the winner has already set fresh cookies, so the
// client should simply retry /auth/me instead of logging the user out.
export const REFRESH_REUSE_GRACE_MS = 30_000;
export const TOKEN_ALREADY_ROTATED = 'Token already rotated';

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

    if (anyMatch.length === 0) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    const token = anyMatch[0];

    if (token.revoked) {
      const revokedAgo = token.revokedAt ? Date.now() - new Date(token.revokedAt).getTime() : Infinity;
      if (revokedAgo <= REFRESH_REUSE_GRACE_MS) {
        // Just rotated by a concurrent request — reject this one, keep other sessions alive
        throw new ConflictException(TOKEN_ALREADY_ROTATED);
      }
      // Token was already used long ago — genuine reuse attack, revoke everything
      await this.tokenService.revokeAllUserTokens(userId);
      throw new UnauthorizedException('Token reuse detected');
    }

    if (token.expiresAt <= new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Rotate atomically: only the request that flips revoked=false → true may
    // issue new tokens; a concurrent loser sees zero rows and is rejected.
    const rotated = await this.drizzle.db
      .update(refreshTokens)
      .set({ revoked: true, revokedAt: new Date() })
      .where(and(eq(refreshTokens.id, token.id), eq(refreshTokens.revoked, false)))
      .returning({ id: refreshTokens.id });

    if (rotated.length === 0) {
      // Lost the race to a concurrent refresh that just rotated this token
      throw new ConflictException(TOKEN_ALREADY_ROTATED);
    }

    const user = await this.drizzle.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (user.length === 0) throw new UnauthorizedException();

    return this.tokenService.issueTokens(user[0].id, user[0].email, user[0].name);
  }
}
