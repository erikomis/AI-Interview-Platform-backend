import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { DatabaseModule } from './infrastructure/database/database.module';
import { MailModule } from './infrastructure/mail/mail.module';

import { JwtStrategy } from './infrastructure/auth/strategies/jwt.strategy';
import { JwtRefreshStrategy } from './infrastructure/auth/strategies/jwt-refresh.strategy';
import { TokenService } from './infrastructure/auth/token.service';
import { LoginAttemptService } from './infrastructure/auth/login-attempt.service';

import { RegisterUseCase } from './application/use-cases/register/register.use-case';
import { LoginUseCase } from './application/use-cases/login/login.use-case';
import { RefreshTokenUseCase } from './application/use-cases/refresh-token/refresh-token.use-case';
import { LogoutUseCase } from './application/use-cases/logout/logout.use-case';
import { LogoutAllUseCase } from './application/use-cases/logout-all/logout-all.use-case';
import { GetProfileUseCase } from './application/use-cases/get-profile/get-profile.use-case';
import { VerifyEmailUseCase } from './application/use-cases/verify-email/verify-email.use-case';
import { ResendVerificationUseCase } from './application/use-cases/resend-verification/resend-verification.use-case';
import { ForgotPasswordUseCase } from './application/use-cases/forgot-password/forgot-password.use-case';
import { ResetPasswordUseCase } from './application/use-cases/reset-password/reset-password.use-case';

import { AuthController } from './presentation/controllers/auth.controller';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({}),
    DatabaseModule,
    MailModule,
  ],
  controllers: [AuthController],
  providers: [
    JwtStrategy,
    JwtRefreshStrategy,
    TokenService,
    LoginAttemptService,
    RegisterUseCase,
    LoginUseCase,
    RefreshTokenUseCase,
    LogoutUseCase,
    LogoutAllUseCase,
    GetProfileUseCase,
    VerifyEmailUseCase,
    ResendVerificationUseCase,
    ForgotPasswordUseCase,
    ResetPasswordUseCase,
  ],
  exports: [JwtModule, TokenService],
})
export class AuthModule {}
