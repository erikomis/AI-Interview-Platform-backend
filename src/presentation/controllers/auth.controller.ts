import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../../infrastructure/auth/guards/jwt-auth.guard';
import { JwtRefreshGuard } from '../../infrastructure/auth/guards/jwt-refresh.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { RegisterUseCase } from '../../application/use-cases/register/register.use-case';
import { LoginUseCase } from '../../application/use-cases/login/login.use-case';
import { RefreshTokenUseCase } from '../../application/use-cases/refresh-token/refresh-token.use-case';
import { LogoutUseCase } from '../../application/use-cases/logout/logout.use-case';
import { LogoutAllUseCase } from '../../application/use-cases/logout-all/logout-all.use-case';
import { GetProfileUseCase } from '../../application/use-cases/get-profile/get-profile.use-case';
import { VerifyEmailUseCase } from '../../application/use-cases/verify-email/verify-email.use-case';
import { ResendVerificationUseCase } from '../../application/use-cases/resend-verification/resend-verification.use-case';
import { ForgotPasswordUseCase } from '../../application/use-cases/forgot-password/forgot-password.use-case';
import { ResetPasswordUseCase } from '../../application/use-cases/reset-password/reset-password.use-case';
import { RegisterDto } from '../../application/use-cases/register/register.dto';
import { LoginDto } from '../../application/use-cases/login/login.dto';
import { ForgotPasswordDto } from '../../application/use-cases/forgot-password/forgot-password.dto';
import { ResetPasswordDto } from '../../application/use-cases/reset-password/reset-password.dto';

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  path: '/auth',
};

const ACCESS_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  maxAge: 1000 * 60 * 15, // 15 minutes
  path: '/',
};

@Controller('auth')
export class AuthController {
  constructor(
    private readonly register: RegisterUseCase,
    private readonly login: LoginUseCase,
    private readonly refreshToken: RefreshTokenUseCase,
    private readonly logout: LogoutUseCase,
    private readonly logoutAll: LogoutAllUseCase,
    private readonly getProfile: GetProfileUseCase,
    private readonly verifyEmail: VerifyEmailUseCase,
    private readonly resendVerification: ResendVerificationUseCase,
    private readonly forgotPassword: ForgotPasswordUseCase,
    private readonly resetPassword: ResetPasswordUseCase,
  ) {}

  @Post('register')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  async handleRegister(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const { accessToken, refreshToken } = await this.register.execute(dto);
    res.cookie('refresh_token', refreshToken, REFRESH_COOKIE_OPTIONS);
    res.cookie('access_token', accessToken, ACCESS_COOKIE_OPTIONS);
    return {};
  }

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async handleLogin(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // req.ip honours X-Forwarded-For only when 'trust proxy' is enabled (TRUST_PROXY=true
    // in main.ts) — reading the raw header would let clients spoof their IP and dodge lockout.
    const ip = req.ip || '0.0.0.0';
    const { accessToken, refreshToken } = await this.login.execute(dto, ip);
    res.cookie('refresh_token', refreshToken, REFRESH_COOKIE_OPTIONS);
    res.cookie('access_token', accessToken, ACCESS_COOKIE_OPTIONS);
    return {};
  }

  @Post('refresh')
  @UseGuards(JwtRefreshGuard)
  @HttpCode(HttpStatus.OK)
  async handleRefresh(
    @CurrentUser() user: { userId: string; rawToken: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken } = await this.refreshToken.execute(user.userId, user.rawToken);
    res.cookie('refresh_token', refreshToken, REFRESH_COOKIE_OPTIONS);
    res.cookie('access_token', accessToken, ACCESS_COOKIE_OPTIONS);
    return {};
  }

  @Post('logout')
  @UseGuards(JwtRefreshGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async handleLogout(
    @CurrentUser() user: { userId: string; rawToken: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.logout.execute(user.userId, user.rawToken);
    res.clearCookie('refresh_token', { path: '/auth' });
    res.clearCookie('access_token', { path: '/' });
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async handleLogoutAll(
    @CurrentUser() user: { userId: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.logoutAll.execute(user.userId);
    res.clearCookie('refresh_token', { path: '/auth' });
    res.clearCookie('access_token', { path: '/' });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async handleMe(@CurrentUser() user: { userId: string }) {
    return this.getProfile.execute(user.userId);
  }

  @Get('verify-email')
  @HttpCode(HttpStatus.OK)
  async handleVerifyEmail(@Query('token') token: string) {
    await this.verifyEmail.execute(token);
    return { message: 'Email verified successfully' };
  }

  @Post('resend-verification')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async handleResendVerification(@CurrentUser() user: { userId: string }) {
    await this.resendVerification.execute(user.userId);
  }

  @Post('forgot-password')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async handleForgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.forgotPassword.execute(dto);
    return { message: 'If that email is registered, a reset link has been sent' };
  }

  @Post('reset-password')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async handleResetPassword(@Body() dto: ResetPasswordDto) {
    await this.resetPassword.execute(dto);
    return { message: 'Password updated. Please sign in.' };
  }
}
