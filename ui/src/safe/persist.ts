/** Asks the browser not to evict the vault under storage pressure (best effort). */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** The "export a backup" reminder shows once the vault holds data and no backup was ever exported. */
export function needsBackupReminder(itemCount: number, lastBackupAt: number | undefined, dismissed: boolean): boolean {
  return itemCount > 0 && !lastBackupAt && !dismissed;
}
