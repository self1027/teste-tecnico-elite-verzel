import type { UserReader, PublicUser } from '../../users/contracts/user-reader.js';
import type { AccessTokens, AuthUseCases, LoginInput, LoginResult, PasswordHasher } from '../contracts/auth.js';
import { AppError, unauthenticated } from '../../../shared/http/app-error.js';

export class AuthService implements AuthUseCases {
  constructor(
    private readonly users: UserReader,
    private readonly passwords: PasswordHasher,
    private readonly tokens: AccessTokens,
    private readonly dummyHash: string,
    private readonly expiresIn: number,
  ) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const credentials = await this.users.findCredentialsByEmail(input.email);
    // Keep password verification work even when the email is unknown.
    const valid = await this.passwords.verify(credentials?.passwordHash ?? this.dummyHash, input.password);
    if (!credentials || !valid) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    const user: PublicUser = {
      id: credentials.id, email: credentials.email,
      displayName: credentials.displayName, role: credentials.role,
    };
    return { accessToken: await this.tokens.issue(user.id), tokenType: 'Bearer', expiresIn: this.expiresIn, user };
  }

  async authenticate(token: string): Promise<PublicUser> {
    const id = await this.tokens.verify(token);
    const user = await this.users.findPublicById(id);
    if (!user) throw unauthenticated();
    return user;
  }
}
