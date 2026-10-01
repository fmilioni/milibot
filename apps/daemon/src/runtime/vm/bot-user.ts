/** The bot's Linux user in the VM. */
export function botLinuxUser(slug: string): string {
  return `bot-${slug}`
}
