import { db } from "../db.ts";

export interface User {
  id: string;
  name: string;
  email: string;
}

// Throws when there is no such user, so callers can rely on the result.
export async function findUser(id: string): Promise<User> {
  const row = await db.query<User>("SELECT id, name, email FROM users WHERE id = $1", [id]);
  if (!row) {
    throw new Error(`User ${id} not found`);
  }
  return row;
}
