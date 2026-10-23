import { argon2id, hash, verify } from 'argon2';
import type { PasswordHasher } from '../contracts/auth.js';

export class ArgonPasswords implements PasswordHasher {
  hash(password: string): Promise<string> {
    return hash(password, { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
  }

  verify(encoded: string, password: string): Promise<boolean> {
    return verify(encoded, password);
  }
}
