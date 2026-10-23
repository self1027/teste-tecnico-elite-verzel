import { eq } from 'drizzle-orm';
import type { Database } from '../../../shared/database/client.js';
import type { PublicUser, UserCredentials, UserReader } from '../contracts/user-reader.js';
import { users } from '../infrastructure/schema.js';

const publicColumns = {
  id: users.id, email: users.email, displayName: users.displayName, role: users.role,
};

export class DrizzleUserReader implements UserReader {
  constructor(private readonly db: Database) {}

  async findCredentialsByEmail(email: string): Promise<UserCredentials | null> {
    const [user] = await this.db.select({ ...publicColumns, passwordHash: users.passwordHash })
      .from(users).where(eq(users.email, email)).limit(1);
    return user ?? null;
  }

  async findPublicById(id: string): Promise<PublicUser | null> {
    const [user] = await this.db.select(publicColumns).from(users).where(eq(users.id, id)).limit(1);
    return user ?? null;
  }
}
