import { Injectable, UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DrizzleService } from '../../../infrastructure/database/drizzle.service';
import { users } from '../../../infrastructure/database/schema';

@Injectable()
export class GetProfileUseCase {
  constructor(private readonly drizzle: DrizzleService) {}

  async execute(userId: string) {
    const user = await this.drizzle.db
      .select({ id: users.id, name: users.name, email: users.email, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (user.length === 0) throw new UnauthorizedException();
    return user[0];
  }
}
