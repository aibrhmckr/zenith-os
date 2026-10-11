// Synthetic ISO9660 with two user-generated PNG files; no game/firmware contents.
function ps3MediaIso(png, sfo = null) {
  const bytes = Buffer.alloc(32 * 2048)
  const both16 = (at, n) => {
    bytes.writeUInt16LE(n, at)
    bytes.writeUInt16BE(n, at + 2)
  }
  const both32 = (at, n) => {
    bytes.writeUInt32LE(n, at)
    bytes.writeUInt32BE(n, at + 4)
  }
  function record(at, name, sector, size, directory) {
    const label = Buffer.isBuffer(name) ? name : Buffer.from(name)
    const length = 33 + label.length + (label.length % 2 === 0 ? 1 : 0)
    bytes[at] = length
    both32(at + 2, sector)
    both32(at + 10, size)
    bytes[at + 18] = 126
    bytes[at + 19] = 1
    bytes[at + 20] = 1
    bytes[at + 25] = directory ? 2 : 0
    both16(at + 28, 1)
    bytes[at + 32] = label.length
    label.copy(bytes, at + 33)
    return length
  }
  const pvd = 16 * 2048
  bytes[pvd] = 1
  bytes.write('CD001', pvd + 1)
  bytes[pvd + 6] = 1
  bytes.fill(32, pvd + 8, pvd + 72)
  both32(pvd + 80, 32)
  both16(pvd + 120, 1)
  both16(pvd + 124, 1)
  both16(pvd + 128, 2048)
  record(pvd + 156, Buffer.from([0]), 20, 2048, true)
  bytes[pvd + 881] = 1
  bytes[17 * 2048] = 255
  bytes.write('CD001', 17 * 2048 + 1)
  bytes[17 * 2048 + 6] = 1
  let at = 20 * 2048
  at += record(at, Buffer.from([0]), 20, 2048, true)
  at += record(at, Buffer.from([1]), 20, 2048, true)
  record(at, 'PS3_GAME', 21, 2048, true)
  at = 21 * 2048
  at += record(at, Buffer.from([0]), 21, 2048, true)
  at += record(at, Buffer.from([1]), 20, 2048, true)
  at += record(at, 'ICON0.PNG;1', 22, png.length, false)
  at += record(at, 'PIC1.PNG;1', 23, png.length, false)
  if (sfo) {
    record(at, 'PARAM.SFO;1', 24, sfo.length, false)
    sfo.copy(bytes, 24 * 2048)
  }
  png.copy(bytes, 22 * 2048)
  png.copy(bytes, 23 * 2048)
  return bytes
}
module.exports = { ps3MediaIso }
