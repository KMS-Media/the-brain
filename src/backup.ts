import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync } from "node:fs";
import { join, relative, dirname } from "node:path";

/**
 * Backup & encryptable storage (PRD §17).
 *
 * Kuzu is an embedded DB with no at-rest encryption of its own, so the
 * "verschlüsselbarer Speicher" requirement is met by an encryptable BACKUP:
 * the database files are packed into a single archive and, when a passphrase
 * is supplied, encrypted with AES-256-GCM (key derived via scrypt). The live
 * working copy stays plaintext (Kuzu can't do otherwise); the persisted backup
 * — the thing you keep around / move off-box — can be fully encrypted.
 *
 * Dependency-free: a tiny length-prefixed archive format, no tar/zip needed.
 */

const ARCHIVE_MAGIC = "BRAINBAK1";
const ENC_MAGIC = "BRAINENC1";
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

/** Recursively collect files under `root`, skipping a nested `backups/` dir. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === "backups") continue;
        walk(join(dir, e.name));
      } else if (e.isFile()) {
        if (e.name === ".brain.lock") continue; // never ship the cross-process lock
        out.push(join(dir, e.name));
      }
    }
  };
  walk(root);
  return out;
}

/** Pack a directory tree into one buffer. */
export function packDir(root: string): Buffer {
  const chunks: Buffer[] = [Buffer.from(ARCHIVE_MAGIC)];
  for (const file of listFiles(root)) {
    const relBuf = Buffer.from(relative(root, file).split("\\").join("/"), "utf8");
    const data = readFileSync(file);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(relBuf.length, 0);
    head.writeUInt32BE(data.length, 4);
    chunks.push(head, relBuf, data);
  }
  return Buffer.concat(chunks);
}

/** Unpack a buffer produced by packDir into `destRoot`. */
export function unpackDir(buf: Buffer, destRoot: string): void {
  if (buf.subarray(0, ARCHIVE_MAGIC.length).toString("utf8") !== ARCHIVE_MAGIC) {
    throw new Error("Not a the_brain archive (or wrong passphrase).");
  }
  let off = ARCHIVE_MAGIC.length;
  while (off < buf.length) {
    const relLen = buf.readUInt32BE(off);
    off += 4;
    const dataLen = buf.readUInt32BE(off);
    off += 4;
    const rel = buf.subarray(off, off + relLen).toString("utf8");
    off += relLen;
    const data = buf.subarray(off, off + dataLen);
    off += dataLen;
    const dest = join(destRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
  }
}

export function encrypt(buf: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(ENC_MAGIC), salt, iv, tag, enc]);
}

export function decrypt(buf: Buffer, passphrase: string): Buffer {
  if (buf.subarray(0, ENC_MAGIC.length).toString("utf8") !== ENC_MAGIC) {
    throw new Error("Not an encrypted the_brain backup.");
  }
  let off = ENC_MAGIC.length;
  const salt = buf.subarray(off, off + SALT_LEN);
  off += SALT_LEN;
  const iv = buf.subarray(off, off + IV_LEN);
  off += IV_LEN;
  const tag = buf.subarray(off, off + TAG_LEN);
  off += TAG_LEN;
  const data = buf.subarray(off);
  const key = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]); // throws on wrong passphrase / tamper
}

/** True if a file looks like an encrypted backup. */
export function isEncrypted(path: string): boolean {
  const fd = readFileSync(path).subarray(0, ENC_MAGIC.length).toString("utf8");
  return fd === ENC_MAGIC;
}

export interface BackupResult {
  path: string;
  encrypted: boolean;
  bytes: number;
}

/**
 * Write a backup of the database under `storageDir`. If `passphrase` is set
 * (e.g. from BRAIN_BACKUP_KEY), the archive is AES-256-GCM encrypted.
 */
export function backupDatabase(storageDir: string, destDir: string, stamp: string, passphrase?: string): BackupResult {
  if (!existsSync(storageDir)) throw new Error(`No storage at ${storageDir}. Run 'brain init' first.`);
  mkdirSync(destDir, { recursive: true });
  let buf: Buffer = packDir(storageDir);
  const encrypted = Boolean(passphrase);
  if (passphrase) buf = encrypt(buf, passphrase);
  const path = join(destDir, `graph-${stamp}.brainbak${encrypted ? ".enc" : ""}`);
  writeFileSync(path, buf);
  return { path, encrypted, bytes: buf.length };
}

/**
 * Restore a backup archive into `storageDir`. Decrypts first if the archive is
 * encrypted (passphrase required). Existing files are overwritten.
 */
export function restoreDatabase(archivePath: string, storageDir: string, passphrase?: string): void {
  if (!existsSync(archivePath)) throw new Error(`Backup not found: ${archivePath}`);
  let buf: Buffer = readFileSync(archivePath);
  if (isEncrypted(archivePath)) {
    if (!passphrase) throw new Error("Backup is encrypted — set BRAIN_BACKUP_KEY to restore.");
    buf = decrypt(buf, passphrase);
  }
  // Clear the existing DB files (keep a nested backups/ dir) before unpacking.
  if (existsSync(storageDir)) {
    for (const e of readdirSync(storageDir, { withFileTypes: true })) {
      if (e.name === "backups") continue;
      rmSync(join(storageDir, e.name), { recursive: true, force: true });
    }
  } else {
    mkdirSync(storageDir, { recursive: true });
  }
  unpackDir(buf, storageDir);
}
