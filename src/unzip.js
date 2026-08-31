// Self-contained ZIP reader supporting STORE (method 0) and DEFLATE (method 8)
// entries. Runs in both the browser and Node with no external dependency.
// The DEFLATE path uses the native DecompressionStream('deflate-raw').
import { crc32 } from './zip.js';

async function inflateRaw(data) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前环境不支持 DecompressionStream，无法解压该 zip');
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Parse a ZIP archive into an array of file entries.
 * @param {Uint8Array | ArrayBuffer} buf raw archive bytes
 * @returns {Promise<{ path: string, data: Uint8Array }[]>}
 */
export async function unzip(buf) {
  const data = new Uint8Array(buf);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Locate the End of Central Directory record (allow an optional comment).
  let eocd = -1;
  const scanStart = Math.max(0, data.length - 22 - 0xffff);
  for (let i = data.length - 22; i >= scanStart; i--) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到中央目录结束记录）');

  const entryCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();

  // Walk the central directory.
  const records = [];
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('中央目录校验失败');
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const uncompSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(data.subarray(p + 46, p + 46 + nameLen));
    records.push({ name, method, crc, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  // Extract each file's bytes.
  const files = [];
  for (const record of records) {
    if (record.name.endsWith('/')) continue; // directory entry

    const local = record.localOffset;
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`本地文件头校验失败：${record.name}`);
    const lNameLen = view.getUint16(local + 26, true);
    const lExtraLen = view.getUint16(local + 28, true);
    const dataStart = local + 30 + lNameLen + lExtraLen;
    const compressed = data.subarray(dataStart, dataStart + record.compSize);

    let raw;
    if (record.method === 0) {
      raw = compressed;
    } else if (record.method === 8) {
      raw = await inflateRaw(compressed);
    } else {
      throw new Error(`不支持的压缩方式（${record.method}）：${record.name}`);
    }

    if (raw.length !== record.uncompSize) throw new Error(`解压大小不符：${record.name}`);
    if (crc32(raw) !== record.crc) throw new Error(`CRC 校验失败：${record.name}`);

    files.push({ path: record.name, data: raw });
  }

  return files;
}
