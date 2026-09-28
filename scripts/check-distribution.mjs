import { execFileSync } from 'node:child_process'
const git = (...args) => execFileSync('git', args, { maxBuffer: 8 * 1024 * 1024 })
// These application assets need documented redistribution rights before publishing.
const assets = new Set([
  'build/icon.png',
  'build/icon.ico',
  'build/icon.icns',
  'build/entitlements.mac.plist',
  'resources/icon.png',
  'src/renderer/src/assets/electron.svg',
  'src/renderer/src/assets/wavy-lines.svg',
  ...['navigate', 'toggle', 'launch'].map((n) => 'src/renderer/src/assets/sounds/' + n + '.wav')
])
const files = git('ls-files', '-z').toString().split('\0').filter(Boolean)
let ignored = ''
try {
  ignored = execFileSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
    input: files.join('\0') + '\0'
  }).toString()
} catch (e) {
  if (e.status !== 1) throw e
  ignored = e.stdout.toString()
}
const violations = new Set(ignored.split('\0').filter((f) => f && !assets.has(f)))
for (const file of files) {
  if (assets.has(file)) continue
  if (
    /(^|\/)(emulators|games|roms|bios|firmware|media|cores|saves|states|manuals|videos|music|cache)(\/|$)/i.test(
      file
    )
  )
    violations.add(file)
  try {
    const bytes = execFileSync('git', ['show', ':' + file], {
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    if (
      bytes.subarray(0, 2).toString() === 'MZ' ||
      bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) ||
      bytes.subarray(0, 2).toString() === 'PK' ||
      bytes.subarray(0, 4).toString() === 'RIFF' ||
      bytes.subarray(1, 4).toString() === 'PNG' ||
      bytes.subarray(0, 8).toString() === 'MComprHD' ||
      (bytes[0] === 255 && bytes[1] === 216)
    )
      violations.add(file)
  } catch {
    violations.add(file)
  }
}
if (violations.size) {
  console.error(
    'Distribution blocked: tracked runtime, binary/media or oversized files:\n' +
      [...violations].join('\n')
  )
  process.exitCode = 1
} else
  console.log(
    'PASS: Git index contains no prohibited runtime artifacts (approved UI assets excepted).'
  )
