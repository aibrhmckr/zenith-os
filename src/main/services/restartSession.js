/** Stop the owned child and wait for close plus launch cleanup before any new spawn. Never call emulator Restart. */
export async function stopForRestart(child, completion, timeoutMs = 10000) {
  if (!child) throw Error('No active game to restart.')
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('close', closed)
      reject(Error('Emulator did not stop. Restart canceled.'))
    }, timeoutMs)
    const closed = () => {
      clearTimeout(timer)
      resolve()
    }
    child.once('close', closed)
    try {
      if (child.kill() === false) {
        clearTimeout(timer)
        child.removeListener('close', closed)
        reject(Error('Unable to stop the emulator.'))
      }
    } catch (error) {
      clearTimeout(timer)
      child.removeListener('close', closed)
      reject(error)
    }
  })
  await completion
}
