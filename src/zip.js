// Minimal self-contained ZIP writer (STORE method, no compression).
// Runs in both the browser and Node, with no external dependency.
// The asset files this project bundles (cube-map JPEGs, textures, the .at3d
// model) are already compressed, so a STORE archive is compact enough and keeps
// this code dependency-free.

const encoder = new TextEncoder();

export function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    (date.getSeconds() >> 1);
  const dosDate =
    ((date.getFullYear() - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, dosDate };
}

/**
 * Build a ZIP archive from an array of entries.
 * @param {{ path: string, data: Uint8Array }[]} entries
 * @returns {Promise<Uint8Array>} the full ZIP file bytes
 */
export async function createZip(entries) {
  const { time, dosDate } = dosDateTime(new Date());
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const data = entry.data;
    const crc = crc32(data);
    const size = data.length;

    // Local file header (30 bytes).
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // signature
    local.setUint16(4, 20, true); // version needed to extract
    local.setUint16(6, 0, true); // general purpose bit flag
    local.setUint16(8, 0, true); // compression method (0 = store)
    local.setUint16(10, time, true); // mod time
    local.setUint16(12, dosDate, true); // mod date
    local.setUint32(14, crc, true); // crc-32
    local.setUint32(18, size, true); // compressed size
    local.setUint32(22, size, true); // uncompressed size
    local.setUint16(26, nameBytes.length, true); // file name length
    local.setUint16(28, 0, true); // extra field length

    chunks.push(new Uint8Array(local.buffer), nameBytes, data);

    // Central directory header (46 bytes).
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); // signature
    cen.setUint16(4, 20, true); // version made by
    cen.setUint16(6, 20, true); // version needed to extract
    cen.setUint16(8, 0, true); // general purpose bit flag
    cen.setUint16(10, 0, true); // compression method
    cen.setUint16(12, time, true); // mod time
    cen.setUint16(14, dosDate, true); // mod date
    cen.setUint32(16, crc, true); // crc-32
    cen.setUint32(20, size, true); // compressed size
    cen.setUint32(24, size, true); // uncompressed size
    cen.setUint16(28, nameBytes.length, true); // file name length
    cen.setUint16(30, 0, true); // extra field length
    cen.setUint16(32, 0, true); // file comment length
    cen.setUint16(34, 0, true); // disk number start
    cen.setUint16(36, 0, true); // internal file attributes
    cen.setUint32(38, 0, true); // external file attributes
    cen.setUint32(42, offset, true); // relative offset of local header

    central.push({ cenBytes: new Uint8Array(cen.buffer), nameBytes });
    offset += 30 + nameBytes.length + size;
  }

  // Central directory.
  const cdSize = central.reduce((sum, c) => sum + 46 + c.nameBytes.length, 0);
  const cdStart = offset;
  for (const c of central) {
    chunks.push(c.cenBytes, c.nameBytes);
  }

  // End of central directory (22 bytes).
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); // signature
  eocd.setUint16(4, 0, true); // number of this disk
  eocd.setUint16(6, 0, true); // disk where central directory starts
  eocd.setUint16(8, central.length, true); // entries on this disk
  eocd.setUint16(10, central.length, true); // total entries
  eocd.setUint32(12, cdSize, true); // central directory size
  eocd.setUint32(16, cdStart, true); // central directory offset
  eocd.setUint16(20, 0, true); // comment length
  chunks.push(new Uint8Array(eocd.buffer));

  // Concatenate everything into a single buffer.
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
