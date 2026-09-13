/**
 * Minimal, dependency-free ZIP writer (store-only, no compression).
 *
 * Exists because a Hubitat bundle is a ZIP and the build should not need a
 * system `zip` binary or an npm dependency to produce one. Bundle contents are
 * a few small Groovy/text files, so skipping compression costs nothing and
 * removes the only part of the format that is easy to get subtly wrong.
 *
 * Deterministic: a fixed DOS timestamp is used so the same inputs always
 * produce a byte-identical archive, which keeps `git diff` on a committed
 * bundle meaningful instead of showing churn on every rebuild.
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// 2020-01-01 00:00:00 in DOS date/time format.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

/**
 * @param {Array<{name: string, data: Buffer|string}>} entries
 * @returns {Buffer} the .zip bytes
 */
export function createZip(entries) {
  const files = entries.map((e) => ({
    name: Buffer.from(e.name, 'utf8'),
    data: Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8'),
  }));

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const crc = crc32(f.data);

    const local = Buffer.alloc(30 + f.name.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18); // compressed size
    local.writeUInt32LE(f.data.length, 22); // uncompressed size
    local.writeUInt16LE(f.name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    f.name.copy(local, 30);

    const central = Buffer.alloc(46 + f.name.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(f.name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    f.name.copy(central, 46);

    locals.push(local, f.data);
    centrals.push(central);
    offset += local.length + f.data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, end]);
}
