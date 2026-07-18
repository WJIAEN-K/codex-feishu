import { inflateRawSync, gunzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, posix, resolve, sep } from "node:path";

import { RuntimeDownloadError } from "./errors.js";

export interface ArchiveLimits {
  maxEntries?: number;
  maxExtractedBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_EXTRACTED_BYTES = 300 * 1024 * 1024;

export async function extractRuntimeArchive(
  archive: Buffer,
  assetName: string,
  destination: string,
  limits: ArchiveLimits = {},
): Promise<void> {
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxExtractedBytes = limits.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED_BYTES;
  await mkdir(destination, { recursive: true });
  if (assetName.endsWith(".tar.gz")) {
    const tar = gunzipSync(archive, { maxOutputLength: maxExtractedBytes });
    await extractTar(tar, destination, maxEntries, maxExtractedBytes);
    return;
  }
  if (assetName.endsWith(".zip")) {
    await extractZip(archive, destination, maxEntries, maxExtractedBytes);
    return;
  }
  throw new RuntimeDownloadError(`Unsupported Runtime archive: ${assetName}`);
}

async function extractTar(
  archive: Buffer,
  destination: string,
  maxEntries: number,
  maxExtractedBytes: number,
): Promise<void> {
  let offset = 0;
  let entries = 0;
  let extractedBytes = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return;
    entries += 1;
    if (entries > maxEntries) throw new RuntimeDownloadError("Runtime archive contains too many entries");
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = parseTarOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    offset += 512;
    if (offset + size > archive.length) throw new RuntimeDownloadError("Runtime tar archive is truncated");
    const target = safeArchivePath(destination, path);
    if (type === "5") {
      await mkdir(target, { recursive: true });
    } else if (type === "0" || type === "\0") {
      extractedBytes += size;
      if (extractedBytes > maxExtractedBytes) throw new RuntimeDownloadError("Runtime archive is too large after extraction");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, archive.subarray(offset, offset + size), { mode: 0o600 });
    } else {
      throw new RuntimeDownloadError(`Runtime tar contains unsupported entry type ${JSON.stringify(type)}`);
    }
    offset += Math.ceil(size / 512) * 512;
  }
  throw new RuntimeDownloadError("Runtime tar archive has no end marker");
}

async function extractZip(
  archive: Buffer,
  destination: string,
  maxEntries: number,
  maxExtractedBytes: number,
): Promise<void> {
  const eocd = findZipEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  if (entryCount > maxEntries) throw new RuntimeDownloadError("Runtime archive contains too many entries");
  let extractedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new RuntimeDownloadError("Runtime zip central directory is invalid");
    }
    const flags = archive.readUInt16LE(offset + 8);
    const compression = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > archive.length) throw new RuntimeDownloadError("Runtime zip entry name is truncated");
    const name = archive.subarray(offset + 46, nameEnd).toString("utf8");
    offset = nameEnd + extraLength + commentLength;
    if (flags & 0x1) throw new RuntimeDownloadError("Encrypted Runtime zip entries are not supported");
    const target = safeArchivePath(destination, name);
    if (name.endsWith("/")) {
      await mkdir(target, { recursive: true });
      continue;
    }
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new RuntimeDownloadError("Runtime zip local header is invalid");
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.length) throw new RuntimeDownloadError("Runtime zip entry is truncated");
    const compressed = archive.subarray(dataStart, dataEnd);
    const contents = compression === 0
      ? compressed
      : compression === 8
        ? inflateRawSync(compressed, { maxOutputLength: maxExtractedBytes - extractedBytes })
        : null;
    if (!contents) throw new RuntimeDownloadError(`Unsupported Runtime zip compression method: ${compression}`);
    if (contents.length !== uncompressedSize) throw new RuntimeDownloadError("Runtime zip entry size does not match its header");
    extractedBytes += contents.length;
    if (extractedBytes > maxExtractedBytes) throw new RuntimeDownloadError("Runtime archive is too large after extraction");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, { mode: 0o600 });
  }
}

export function safeArchivePath(destination: string, entryName: string): string {
  const unixName = entryName.replaceAll("\\", "/");
  if (!unixName || unixName.includes("\0") || unixName.startsWith("/")
    || /^[A-Za-z]:/.test(unixName)) {
    throw new RuntimeDownloadError(`Unsafe Runtime archive path: ${entryName}`);
  }
  const normalized = posix.normalize(unixName);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new RuntimeDownloadError(`Unsafe Runtime archive path: ${entryName}`);
  }
  const root = resolve(destination);
  const target = resolve(root, ...normalized.split("/"));
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new RuntimeDownloadError(`Unsafe Runtime archive path: ${entryName}`);
  }
  return target;
}

function findZipEndOfCentralDirectory(archive: Buffer): number {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new RuntimeDownloadError("Runtime zip has no end-of-central-directory record");
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
  const value = buffer.subarray(offset, offset + length);
  const end = value.indexOf(0);
  return value.subarray(0, end < 0 ? value.length : end).toString("utf8").trim();
}

function parseTarOctal(buffer: Buffer, offset: number, length: number): number {
  const value = readTarString(buffer, offset, length).replaceAll("\0", "").trim();
  if (!/^[0-7]+$/.test(value)) throw new RuntimeDownloadError("Runtime tar has an invalid entry size");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RuntimeDownloadError("Runtime tar entry is too large");
  return parsed;
}
