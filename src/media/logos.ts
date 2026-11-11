import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Stores an uploaded logo per chat as a base64 data URI, so Forge can embed it
 * directly into the self-contained site (no external image request). In prod
 * this moves to Cloudflare R2; locally it's just a file.
 */
const LOGO_DIR = join(process.cwd(), ".data", "logos");

function logoPath(channel: string, chatId: string): string {
  const safe = `${channel}_${chatId}`.replace(/[^\w.-]/g, "_");
  return join(LOGO_DIR, `${safe}.txt`);
}

export async function saveLogo(
  channel: string,
  chatId: string,
  dataUri: string,
): Promise<void> {
  const path = logoPath(channel, chatId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, dataUri, "utf8");
}

export async function getLogo(
  channel: string,
  chatId: string,
): Promise<string | null> {
  const path = logoPath(channel, chatId);
  if (!existsSync(path)) return null;
  return readFile(path, "utf8");
}

/**
 * Forget the stored logo after it's been embedded into a build — otherwise it
 * bleeds onto the NEXT (different) site the customer builds in the same chat.
 * The site keeps its own copy in its HTML, so clearing here is safe.
 */
export async function clearLogo(channel: string, chatId: string): Promise<void> {
  const path = logoPath(channel, chatId);
  if (existsSync(path)) await rm(path).catch(() => {});
}
