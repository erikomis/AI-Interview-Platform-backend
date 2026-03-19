import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { DrizzleService } from '../../../infrastructure/database/drizzle.service';
import { RedisService } from '../../../infrastructure/database/redis.service';
import { MailService } from '../../../infrastructure/mail/mail.service';
import { hashToken } from '../../../infrastructure/auth/token.utils';
import { users } from '../../../infrastructure/database/schema';
import { ForgotPasswordDto } from './forgot-password.dto';

const PASSWORD_RESET_TTL = 60 * 60; // 1 hour

@Injectable()
export class ForgotPasswordUseCase {
  private readonly logger = new Logger(ForgotPasswordUseCase.name);

  constructor(
    private readonly drizzle: DrizzleService,
    private readonly redis: RedisService,
    private readonly mail: MailService,
  ) {}

  async execute(dto: ForgotPasswordDto) {
    const email = dto.email.toLowerCase().trim();

    const user = await this.drizzle.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // Always return success to avoid user enumeration
    if (user.length === 0) return;

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    await this.redis.set(`password:reset:${tokenHash}`, user[0].id, PASSWORD_RESET_TTL);
    await this.mail.sendPasswordResetEmail(email, user[0].name, rawToken);
    this.logger.log(`Password reset email sent to: ${email}`);
  }
}
