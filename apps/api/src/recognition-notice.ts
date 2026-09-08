import type { Transaction } from "kysely";
import type { Database } from "./db.js";

/** Persist the current failure episode independently of whether its notification was read/deleted. */
export async function updateRecognitionNotice(trx: Transaction<Database>, applicationId: string, key: string | null): Promise<boolean> {
  const previous = await trx.selectFrom("applications").select("recognition_notice_key").where("id", "=", applicationId).executeTakeFirst();
  await trx.updateTable("applications").set({ recognition_notice_key: key }).where("id", "=", applicationId).execute();
  return key !== null && previous?.recognition_notice_key !== key;
}
