import type { DriverEntry, DriverUpdate, HardwareSnapshot, SourceStatus } from '../../../shared/types'

export interface SourceContext {
  hardware: HardwareSnapshot
  drivers: DriverEntry[]
  /** Honours the user's privacy settings — false means "do not touch the network". */
  allowNetwork: boolean
  signal: { aborted: boolean }
}

export interface SourceResult {
  status: Omit<SourceStatus, 'durationMs'>
  updates: DriverUpdate[]
}

export interface DriverSource {
  id: string
  label: string
  kind: 'windows-update' | 'vendor-api' | 'vendor-page'
  /** Whether this source has anything to say about the current machine. */
  applicable(ctx: SourceContext): boolean
  check(ctx: SourceContext): Promise<SourceResult>
}
