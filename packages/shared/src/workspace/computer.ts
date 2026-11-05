import { z } from 'zod'

/** What the bots of a workspace work on: its own QEMU VM, or no computer at all. */
export const ComputerKind = z.enum(['vm', 'none'])
export type ComputerKind = z.infer<typeof ComputerKind>

/**
 * What a computer offers the bots: `shell` a /workspace filesystem and commands (CLI engines need it too),
 * `desktop` a screen and input, `browser` a Chrome the bots and the design renderer drive, `documents`
 * PDF/Office/OCR extraction.
 */
export const ComputerCapability = z.enum(['shell', 'desktop', 'browser', 'documents'])
export type ComputerCapability = z.infer<typeof ComputerCapability>

const COMPUTER_CAPABILITIES: Record<ComputerKind, readonly ComputerCapability[]> = {
  vm: ComputerCapability.options,
  none: [],
}

export function computerCapabilities(kind: ComputerKind): ReadonlySet<ComputerCapability> {
  return new Set(COMPUTER_CAPABILITIES[kind])
}

export const VM_SIZE_LIMITS = {
  minCpus: 1,
  minMemGb: 2,
  minDataGb: 20,
  maxDataGb: 500,
  dataStepGb: 10,
} as const

export const SetupVmBody = z.object({
  cpus: z.number().int().positive().max(128),
  memGb: z.number().int().positive().max(1024),
  dataGb: z.number().int().min(VM_SIZE_LIMITS.minDataGb).max(VM_SIZE_LIMITS.maxDataGb),
})
export type SetupVmBody = z.input<typeof SetupVmBody>

const NoComputer = z.object({ kind: z.literal(ComputerKind.enum.none) })

/** A VM without `size` keeps the size the workspace already has. */
export const ComputerChoice = z.discriminatedUnion('kind', [
  NoComputer,
  z.object({ kind: z.literal(ComputerKind.enum.vm), size: SetupVmBody.optional() }),
])
export type ComputerChoice = z.infer<typeof ComputerChoice>

/** The setup always sizes the VM it creates. */
export const SetupComputerBody = z.discriminatedUnion('kind', [
  NoComputer,
  z.object({ kind: z.literal(ComputerKind.enum.vm), size: SetupVmBody }),
])
export type SetupComputerBody = z.input<typeof SetupComputerBody>

export const DeletedVm = z.object({ freedBytes: z.number().int().nonnegative() })
export type DeletedVm = z.infer<typeof DeletedVm>
