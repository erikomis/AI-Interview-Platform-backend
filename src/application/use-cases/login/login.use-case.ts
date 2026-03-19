import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { DrizzleService } from '../../../infrastructure/database/drizzle.service';
import { TokenService } from '../../../infrastructure/auth/token.service';
import { LoginAttemptService } from '../../../infrastructure/auth/login-attempt.service';
import { users } from '../../../infrastructure/database/schema';
import { LoginDto } from './login.dto';

@Injectable()
export class LoginUseCase {
  private readonly logger = new Logger(LoginUseCase.name);

  constructor(
    private readonly drizzle: DrizzleService,
    private readonly tokenService: TokenService,
    private readonly loginAttempt: LoginAttemptService,
  ) {}

  async execute(dto: LoginDto, ip: string) {
    const email = dto.email.toLowerCase().trim();

    await this.loginAttempt.checkLockout(email, ip);

    const user = await this.drizzle.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    const isValid =
      user.length > 0 && (await bcrypt.compare(dto.password, user[0].passwordHash));

    if (!isValid) {
      await this.loginAttempt.recordFailedAttempt(email, ip);
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.loginAttempt.clearFailedAttempts(email, ip);
    this.logger.log(`User logged in: ${email}`);
    return this.tokenService.issueTokens(user[0].id, user[0].email, user[0].name);
  }
}
