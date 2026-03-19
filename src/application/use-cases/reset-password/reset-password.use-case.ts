import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { DrizzleService } from '../../../infrastructure/database/drizzle.service';
import { RedisService } from '../../../infrastructure/database/redis.service';
import { TokenService } from '../../../infrastructure/auth/token.service';
import { hashToken } from '../../../infrastructure/auth/token.utils';
import { users } from '../../../infrastructure/database/schema';
import { ResetPasswordDto } from './reset-password.dto';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class ResetPasswordUseCase {
  private readonly logger = new Logger(ResetPasswordUseCase.name);

  constructor(
    private readonly drizzle: DrizzleService,
    private readonly redis: RedisService,
    private readonly tokenService: TokenService,
  ) {}

  async execute(dto: ResetPasswordDto) {
    const tokenHash = hashToken(dto.token);
    const userId = await this.redis.get(`password:reset:${tokenHash}`);

    if (!userId) throw new BadRequestException('Invalid or expired reset link');

    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);

    await this.drizzle.db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, userId));

    // Revoke all sessions after password change
    await this.tokenService.revokeAllUserTokens(userId);
    await this.redis.del(`password:reset:${tokenHash}`);
    this.logger.log(`Password reset for user: ${userId}`);
  }
}
