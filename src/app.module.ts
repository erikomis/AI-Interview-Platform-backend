import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { InterviewModule } from './interview.module';
import { AuthModule } from './auth.module';
import { validateEnv } from './infrastructure/config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env', validate: validateEnv }),

    // Global rate limiting: 60 requests / 60 seconds per IP
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),

    AuthModule,
    InterviewModule,
  ],
  providers: [
    // Apply throttler globally
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
