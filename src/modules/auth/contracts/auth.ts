import type { PublicUser } from '../../users/contracts/user-reader.js';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface AccessTokens {
  issue(subject: string): Promise<string>;
  verify(token: string): Promise<string>;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: PublicUser;
}

export interface AuthUseCases {
  login(input: LoginInput): Promise<LoginResult>;
  authenticate(token: string): Promise<PublicUser>;
}
