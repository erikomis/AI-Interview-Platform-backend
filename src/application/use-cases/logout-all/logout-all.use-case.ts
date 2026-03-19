import { Injectable } from '@nestjs/common';
import { TokenService } from '../../../infrastructure/auth/token.service';

@Injectable()
export class LogoutAllUseCase {
  constructor(private readonly tokenService: TokenService) {}

  async execute(userId: string) {
    await this.tokenService.revokeAllUserTokens(userId);
  }
}
