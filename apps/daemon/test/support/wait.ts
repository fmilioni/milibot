export async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
