import { IsEmail, IsString, MinLength, MaxLength, Matches } from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name: string;

  @IsEmail()
  @MaxLength(254)
  email: string;

  /**
   * Min 8 chars, at least:
   *   1 uppercase  (A-Z)
   *   1 lowercase  (a-z)
   *   1 digit      (0-9)
   *   1 special    (!@#$%^&*...)
   */
  @IsString()
  @MinLength(8)
  @MaxLength(72) // bcrypt hard limit
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?])/, {
    message:
      'Password must contain at least 1 uppercase letter, 1 lowercase letter, 1 number and 1 special character',
  })
  password: string;
}
