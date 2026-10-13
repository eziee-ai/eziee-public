import type { Db } from "./client";
import { waitlist } from "./schema";

export async function joinWaitlist(db: Db, email: string) {
  await db.insert(waitlist).values({ email: email.trim().toLowerCase() }).onConflictDoNothing();
}
