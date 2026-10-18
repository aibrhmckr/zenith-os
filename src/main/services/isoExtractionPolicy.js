const TARGETS = /^(ICON0\.PNG|PIC1\.PNG|PARAM\.SFO|PS3_DISC\.SFB)$/i

/** Validate every matching member before any extraction; forced ISO/UDF excludes compressed bombs. */
export function validateIsoMembers(listing) {
  let total = 0,
    count = 0
  for (const block of listing.split(/\r?\n\s*\r?\n/)) {
    const fields = Object.fromEntries(
      block.split(/\r?\n/).flatMap((line) => {
        const split = line.indexOf(' = ')
        return split < 0 ? [] : [[line.slice(0, split), line.slice(split + 3)]]
      })
    )
    const name = fields.Path?.split(/[\\/]/).at(-1)
    if (!name || !TARGETS.test(name)) continue
    const size = /^\d+$/.test(fields.Size || '') ? Number(fields.Size) : NaN
    const limit = /\.PNG$/i.test(name) ? 20 * 1024 * 1024 : 1024 * 1024
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > limit ||
      fields['Symbolic Link'] ||
      fields['Hard Link'] ||
      fields.Path.split(/[\\/]/).includes('..')
    )
      throw Error('Unsafe ISO artwork member.')
    total += size
    count++
    if (total > 42 * 1024 * 1024 || count > 16) throw Error('ISO artwork size limit exceeded.')
  }
  if (!count) throw Error('No bounded ISO artwork members found.')
  return { total, count }
}

export async function inspectIsoExtraction(binary, file, execute) {
  let lastError
  for (const format of ['-tudf', '-tiso']) {
    try {
      let listing
      try {
        listing = await execute(binary, ['l', format, '-slt', '-ba', '-p', '--', file], {
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 4 * 1024 * 1024
        })
      } catch (error) {
        if (!/Headers Error/i.test([error.message, error.stderr].join('\n')) || !error.stdout)
          throw error
        listing = { stdout: error.stdout }
      }
      validateIsoMembers(String(listing.stdout || ''))
      return format
    } catch (error) {
      lastError = error
    }
  }
  throw Object.assign(Error('PS3 ISO: no safe extraction plan', { cause: lastError }), {
    code: 'PS3_ISO_EXTRACTION_FAILED'
  })
}
