import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { RedisService } from '../database/redis.service';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_TTL = 60 * 15; // 15 minutes

@Injectable()
export class LoginAttemptService {
  private readonly logger = new Logger(LoginAttemptService.name);

  constructor(private readonly redis: RedisService) {}

  async checkLockout(email: string, ip: string) {
    const locked = await this.redis.get(this.lockoutKey(email, ip));
    if (locked) {
      throw new UnauthorizedException('Account temporarily locked. Try again in 15 minutes.');
    }
  }

  async recordFailedAttempt(email: string, ip: string) {
    const key = this.attemptsKey(email, ip);
    const raw = await this.redis.get(key);
    const attempts = raw ? parseInt(raw, 10) + 1 : 1;

    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      await this.redis.set(this.lockoutKey(email, ip), '1', LOCKOUT_TTL);
      await this.redis.del(key);
      this.logger.warn(`Account locked out: ${email} from ${ip}`);
    } else {
      await this.redis.set(key, String(attempts), 60 * 10); // 10-min window
    }
  }

  async clearFailedAttempts(email: string, ip: string) {
    await this.redis.del(this.attemptsKey(email, ip));
    await this.redis.del(this.lockoutKey(email, ip));
  }

  private lockoutKey(email: string, ip: string) {
    return `auth:lockout:${email}:${ip}`;
  }

  private attemptsKey(email: string, ip: string) {
    return `auth:attempts:${email}:${ip}`;
  }
}
