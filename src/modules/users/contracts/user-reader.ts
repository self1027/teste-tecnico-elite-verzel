export type UserRole = 'AUCTIONEER' | 'BIDDER';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
}

export interface UserCredentials extends PublicUser {
  passwordHash: string;
}

export interface UserReader {
  findCredentialsByEmail(email: string): Promise<UserCredentials | null>;
  findPublicById(id: string): Promise<PublicUser | null>;
}
