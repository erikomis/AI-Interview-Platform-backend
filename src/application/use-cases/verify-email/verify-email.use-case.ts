import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DrizzleService } from '../../../infrastructure/database/drizzle.service';
import { RedisService } from '../../../infrastructure/database/redis.service';
import { hashToken } from '../../../infrastructure/auth/token.utils';
import { users } from '../../../infrastructure/database/schema';

@Injectable()
export class VerifyEmailUseCase {
  private readonly logger = new Logger(VerifyEmailUseCase.name);

  constructor(
    private readonly drizzle: DrizzleService,
    private readonly redis: RedisService,
  ) {}

  async execute(rawToken: string) {
    const tokenHash = hashToken(rawToken);
    const userId = await this.redis.get(`email:verify:${tokenHash}`);

    if (!userId) throw new BadRequestException('Invalid or expired verification link');

    await this.drizzle.db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, userId));

    await this.redis.del(`email:verify:${tokenHash}`);
    this.logger.log(`Email verified for user: ${userId}`);
  }
}
