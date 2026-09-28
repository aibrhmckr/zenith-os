// Synthetic PE header inside a ZIP, not executable emulator code.
const { deflateRawSync } = require('node:zlib')
function coreArchive(name, payload) {
  const dll = payload || Buffer.alloc(256)
  if (!payload) {
    if (name.endsWith('.so')) {
      dll.writeUInt32BE(0x7f454c46)
      dll[4] = 2
      dll[5] = 1
      dll.writeUInt16LE(3, 16)
      dll.writeUInt16LE(62, 18)
    } else {
      dll.write('MZ')
      dll.writeUInt32LE(64, 60)
      dll.writeUInt32LE(0x4550, 64)
      dll.writeUInt16LE(0x8664, 68)
    }
  }
  let crc = 0xffffffff
  for (const byte of dll) {
    crc ^= byte
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  crc = (crc ^ 0xffffffff) >>> 0
  const filename = Buffer.from(name),
    data = deflateRawSync(dll)
  const local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22)
  local.writeUInt32LE(0x04034b50)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(dll.length, 22)
  local.writeUInt16LE(filename.length, 26)
  central.writeUInt32LE(0x02014b50)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(dll.length, 24)
  central.writeUInt16LE(filename.length, 28)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + filename.length, 12)
  end.writeUInt32LE(local.length + filename.length + data.length, 16)
  return Buffer.concat([local, filename, data, central, filename, end])
}
module.exports = { coreArchive }
