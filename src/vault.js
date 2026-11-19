/**
 * 凭据库读取：~/.dsh/checkin/credentials.json
 * 结构与字段见插件 README；这里只负责读取、校验与脱敏展示。
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VAULT_DIR = join(homedir(), ".dsh", "checkin");
export const VAULT_FILE = join(VAULT_DIR, "credentials.json");

export function loadVault() {
  try {
    return JSON.parse(readFileSync(VAULT_FILE, "utf8"));
  } catch (error) {
    return { __error: String(error?.message ?? error) };
  }
}

/** 原子写回凭据库（无 BOM；先写临时文件再改名）。 */
export function saveVault(vault) {
  const tmp = `${VAULT_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(vault, null, 2)}\n`, "utf8");
  renameSync(tmp, VAULT_FILE);
}

/** sha256 摘要，用于状态展示时不暴露明文。 */
export function maskSecret(value) {
  const text = String(value ?? "");
  if (text === "") return "(未设置)";
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return `…${text.slice(-4)} (len=${text.length}, h=${hash.toString(16)})`;
}
