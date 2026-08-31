export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

export function crc32(data: Uint8Array): number;

export function createZip(entries: ZipEntry[]): Promise<Uint8Array>;
