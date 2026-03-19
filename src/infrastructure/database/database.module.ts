import { Global, Module } from '@nestjs/common';
import { DrizzleService } from './drizzle.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [DrizzleService, RedisService],
  exports: [DrizzleService, RedisService],
})
export class DatabaseModule {}
