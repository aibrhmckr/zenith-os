/** Conservative identity classification: AMD vendor ID alone does not distinguish APUs. */
export function classifyGpu(info = {}) {
  const devices = (Array.isArray(info.gpuDevice) ? info.gpuDevice : []).map((device) => {
    const name = String(
      device.deviceString || device.driverVendor || device.vendorString || 'Unknown GPU'
    ).slice(0, 200)
    const software = /swiftshader|llvmpipe|software|basic render/i.test(name)
    const integrated =
      /intel.*(hd|uhd|iris)|radeon.*(?:610m|6[68]0m|7[4689]0m|8[069]0m|vega|graphics)|\bapu\b/i.test(
        name
      )
    const dedicated =
      !software &&
      !integrated &&
      (Number(device.vendorId) === 0x10de ||
        /geforce|quadro|radeon.*(?:rx|pro)|intel.*arc\s+[ab]\d/i.test(name))
    return {
      name,
      vendorId: device.vendorId ?? null,
      deviceId: device.deviceId ?? null,
      active: device.active === true,
      type: software
        ? 'software'
        : dedicated
          ? 'dedicated'
          : integrated || Number(device.vendorId) === 0x8086
            ? 'integrated'
            : 'unknown'
    }
  })
  const explicit = devices.filter((device) => device.active)
  const active = explicit
  const dedicated = active.some((device) => device.type === 'dedicated')
  return {
    devices,
    classification: dedicated ? 'dedicated' : 'fallback',
    detected: devices.length > 0,
    activeKnown: active.length > 0,
    profile: dedicated ? 'balanced' : 'conservative',
    checkedAt: new Date().toISOString()
  }
}

/** Single-flight, bounded GPU queries; an unavailable GPU service never blocks launch. */
export function createHardwareDetector({ app, publish = () => {}, timeoutMs = 3000 }) {
  let snapshot = classifyGpu(),
    pending = null,
    checkedAt = 0
  return {
    snapshot: () => structuredClone(snapshot),
    detect({ force = false } = {}) {
      if (!force && checkedAt && Date.now() - checkedAt < 60000)
        return Promise.resolve(structuredClone(snapshot))
      if (pending) return pending
      pending = (async () => {
        let timer
        try {
          const info = await Promise.race([
            (async () => {
              const basic = await app.getGPUInfo('basic')
              if (!basic?.gpuDevice?.some((device) => !device.deviceString)) return basic
              // Complete information can supply names absent in basic, especially for AMD APUs.
              try {
                return await app.getGPUInfo('complete')
              } catch {
                return basic
              }
            })(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(Error('GPU query timeout')), timeoutMs)
            })
          ])
          snapshot = classifyGpu(info)
          checkedAt = Date.now()
        } catch {
          snapshot = { ...classifyGpu(), unavailable: true }
        } finally {
          clearTimeout(timer)
        }
        try {
          publish(structuredClone(snapshot))
        } catch {
          /* A closed renderer is harmless. */
        }
        return structuredClone(snapshot)
      })().finally(() => {
        pending = null
      })
      return pending
    }
  }
}

/** Identity is not a benchmark: retain native 720p even on dGPU; increase precision, not load. */
export function rpcs3HardwareProfile(hardware) {
  const dedicated = hardware?.classification === 'dedicated'
  return {
    Core: { 'SPU Block Size': dedicated ? 'Safe' : 'Mega' },
    Video: {
      Resolution: '1280x720',
      'Resolution Scale': 100,
      'Shader Precision': dedicated ? 'High' : 'Low',
      'Shader Mode': 'Async Recompiler (multi-threaded)',
      'Disable On-Disk Shader Cache': false
    }
  }
}
