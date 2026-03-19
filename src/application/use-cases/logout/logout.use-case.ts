import { Injectable } from '@nestjs/common';
import { TokenService } from '../../../infrastructure/auth/token.service';

@Injectable()
export class LogoutUseCase {
  constructor(private readonly tokenService: TokenService) {}

  async execute(userId: string, rawToken: string) {
    await this.tokenService.revokeToken(userId, rawToken);
  }
}
