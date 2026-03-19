import { Injectable, ConflictException, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { DrizzleService } from '../../../infrastructure/database/drizzle.service';
import { RedisService } from '../../../infrastructure/database/redis.service';
import { MailService } from '../../../infrastructure/mail/mail.service';
import { TokenService } from '../../../infrastructure/auth/token.service';
import { hashToken } from '../../../infrastructure/auth/token.utils';
import { users } from '../../../infrastructure/database/schema';
import { RegisterDto } from './register.dto';

const BCRYPT_ROUNDS = 12;
const EMAIL_VERIFY_TTL = 60 * 60 * 24; // 24 hours

@Injectable()
export class RegisterUseCase {
  private readonly logger = new Logger(RegisterUseCase.name);

  constructor(
    private readonly drizzle: DrizzleService,
    private readonly redis: RedisService,
    private readonly mail: MailService,
    private readonly tokenService: TokenService,
  ) {}

  async execute(dto: RegisterDto) {
    const email = dto.email.toLowerCase().trim();

    const existing = await this.drizzle.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existing.length > 0) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const userId = uuidv4();

    await this.drizzle.db.insert(users).values({
      id: userId,
      name: dto.name.trim(),
      email,
      passwordHash,
    });

    this.logger.log(`New user registered: ${email}`);
    const tokens = await this.tokenService.issueTokens(userId, email, dto.name.trim());

    this.sendVerificationEmail(userId).catch((err) =>
      this.logger.error(`Failed to send verification email: ${err.message}`),
    );

    return tokens;
  }

  private async sendVerificationEmail(userId: string) {
    const user = await this.drizzle.db
      .select({ email: users.email, name: users.name, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (user.length === 0 || user[0].emailVerified) return;

    const { randomBytes } = await import('crypto');
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    await this.redis.set(`email:verify:${tokenHash}`, userId, EMAIL_VERIFY_TTL);
    await this.mail.sendVerificationEmail(user[0].email, user[0].name, rawToken);
  }
}
