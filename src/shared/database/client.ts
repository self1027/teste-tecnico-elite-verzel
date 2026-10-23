import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

export type Database = NodePgDatabase;

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return { db: drizzle({ client: pool }), pool };
}
