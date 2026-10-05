// Construct only synthetic metadata; no game/firmware binary fixture is redistributed.
function paramSfo(values) {
  const entries = Object.entries(values)
  const keys = Buffer.from(entries.map(([key]) => key + '\0').join(''))
  const strings = entries.map(([, value]) => Buffer.from(value + '\0'))
  const dataOffset = 20 + entries.length * 16 + keys.length
  const out = Buffer.alloc(dataOffset + strings.reduce((n, b) => n + b.length, 0))
  out.writeUInt32LE(0x46535000, 0)
  out.writeUInt32LE(0x101, 4)
  out.writeUInt32LE(20 + entries.length * 16, 8)
  out.writeUInt32LE(dataOffset, 12)
  out.writeUInt32LE(entries.length, 16)
  keys.copy(out, 20 + entries.length * 16)
  let keyOffset = 0,
    data = 0
  entries.forEach(([key], i) => {
    const at = 20 + i * 16,
      value = strings[i]
    out.writeUInt16LE(keyOffset, at)
    out.writeUInt16LE(0x204, at + 2)
    out.writeUInt32LE(value.length, at + 4)
    out.writeUInt32LE(value.length, at + 8)
    out.writeUInt32LE(data, at + 12)
    value.copy(out, dataOffset + data)
    keyOffset += Buffer.byteLength(key) + 1
    data += value.length
  })
  return out
}
module.exports = { paramSfo }
