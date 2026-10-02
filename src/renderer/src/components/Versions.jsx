import { useState } from 'react'

/**
 * Display the preload-exposed runtime versions from a stable snapshot. This template component
 * is not mounted in the dashboard.
 */
function Versions() {
  /**
   * Snapshot of Electron, Chromium, and Node versions exposed by toolkit preload.
   */
  const [versions] = useState(window.electron.process.versions)

  return (
    <ul className="versions">
      <li className="electron-version">Electron v{versions.electron}</li>
      <li className="chrome-version">Chromium v{versions.chrome}</li>
      <li className="node-version">Node v{versions.node}</li>
    </ul>
  )
}

export default Versions
