export const VM_DESKTOP = { width: 1280, height: 800 }
/** Slim toolbar above the desktop (control badge, take over/give back, full screen, close). */
export const VM_TOOLBAR_HEIGHT = 40

/** Content size that shows `VM_DESKTOP` 1:1, or the largest window of its aspect ratio that fits. */
export function vmWindowSize(workArea: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(
    1,
    workArea.width / VM_DESKTOP.width,
    (workArea.height - VM_TOOLBAR_HEIGHT) / VM_DESKTOP.height,
  )
  return {
    width: Math.round(VM_DESKTOP.width * scale),
    height: Math.round(VM_DESKTOP.height * scale) + VM_TOOLBAR_HEIGHT,
  }
}
