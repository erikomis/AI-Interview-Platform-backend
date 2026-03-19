import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { DrizzleService } from '../../../infrastructure/database/drizzle.service';
import { RedisService } from '../../../infrastructure/database/redis.service';
import { MailService } from '../../../infrastructure/mail/mail.service';
import { hashToken } from '../../../infrastructure/auth/token.utils';
import { users } from '../../../infrastructure/database/schema';

const EMAIL_VERIFY_TTL = 60 * 60 * 24; // 24 hours

@Injectable()
export class ResendVerificationUseCase {
  private readonly logger = new Logger(ResendVerificationUseCase.name);

  constructor(
    private readonly drizzle: DrizzleService,
    private readonly redis: RedisService,
    private readonly mail: MailService,
  ) {}

  async execute(userId: string) {
    const user = await this.drizzle.db
      .select({ email: users.email, name: users.name, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (user.length === 0 || user[0].emailVerified) return;

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    await this.redis.set(`email:verify:${tokenHash}`, userId, EMAIL_VERIFY_TTL);
    await this.mail.sendVerificationEmail(user[0].email, user[0].name, rawToken);
    this.logger.log(`Verification email resent to user: ${userId}`);
  }
}
