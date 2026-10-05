// Minimal synthetic ISO9660 metadata; no copyrighted disc contents.
function discImage(platform) {
  const out = Buffer.alloc(24 * 2048)
  const pvd = 16 * 2048
  out[pvd] = 1
  out.write('CD001', pvd + 1)
  out[pvd + 6] = 1
  out.writeUInt16LE(2048, pvd + 128)
  out.writeUInt16BE(2048, pvd + 130)
  out[pvd + 156] = 34
  out.writeUInt32LE(20, pvd + 158)
  out.writeUInt32LE(2048, pvd + 166)
  out[17 * 2048] = 255
  out.write('CD001', 17 * 2048 + 1)
  out[17 * 2048 + 6] = 1
  const name = platform === 'PS3' ? 'PS3_GAME' : platform === 'PSP' ? 'PSP_GAME' : 'SYSTEM.CNF;1'
  const at = 20 * 2048
  out[at] = 34 + name.length
  out[at + 32] = name.length
  out.write(name, at + 33)
  out[at + 25] = platform === 'PS3' || platform === 'PSP' ? 2 : 0
  if (platform === 'PS2' || platform === 'PS1') {
    const boot = platform === 'PS2' ? 'BOOT2 = cdrom0:\\TEST;1' : 'BOOT = cdrom:\\TEST;1'
    out.writeUInt32LE(21, at + 2)
    out.writeUInt32LE(boot.length, at + 10)
    out.write(boot, 21 * 2048)
  }
  return out
}
module.exports = { discImage }
