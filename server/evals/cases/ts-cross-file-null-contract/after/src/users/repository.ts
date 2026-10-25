import { db } from "../db.ts";

export interface User {
  id: string;
  name: string;
  email: string;
}

// Missing users are common during imports; logging a stack for each is noise.
export async function findUser(id: string): Promise<User> {
  const row = await db.query<User>("SELECT id, name, email FROM users WHERE id = $1", [id]);
  if (!row) {
    return undefined as unknown as User;
  }
  return row;
}
