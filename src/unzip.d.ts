export interface UnzipEntry {
  path: string;
  data: Uint8Array;
}

export function unzip(buf: Uint8Array | ArrayBuffer): Promise<UnzipEntry[]>;
