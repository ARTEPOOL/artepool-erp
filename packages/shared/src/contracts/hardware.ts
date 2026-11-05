/**
 * The guided hardware check (M7 part D, decision 0119): the only human step of the acceptance.
 * The owner checks each PC on that PC, about 5 minutes: on a POS PC a test receipt, the drawer, a
 * test label and the scan of that label's barcode; on an office PC or the laptop an A4 test page.
 */
import { z } from 'zod';
import { OptionalText } from './common';

export const HARDWARE_STEPS = ['receipt', 'drawer', 'label', 'scan', 'a4'] as const;
export type HardwareStep = (typeof HARDWARE_STEPS)[number];

/** The steps of a PC, by its kind: the POS PC's printers, drawer and scanner; elsewhere A4. */
export function hardwareStepsFor(kind: 'pos' | 'office' | 'warehouse' | 'server'): HardwareStep[] {
  return kind === 'pos' ? ['receipt', 'drawer', 'label', 'scan'] : ['a4'];
}

export const HARDWARE_OUTCOMES = ['ok', 'problem'] as const;
export type HardwareOutcome = (typeof HARDWARE_OUTCOMES)[number];

export const HardwareResult = z.object({
  step: z.enum(HARDWARE_STEPS),
  outcome: z.enum(HARDWARE_OUTCOMES),
  note: OptionalText(500),
});
export type HardwareResult = z.infer<typeof HardwareResult>;

export const HardwareCheckRequest = z.object({
  results: z.array(HardwareResult).min(1).max(HARDWARE_STEPS.length),
});
export type HardwareCheckRequest = z.infer<typeof HardwareCheckRequest>;

export interface HardwareCheck {
  id: string;
  deviceCode: string;
  deviceName: string;
  checkedAt: string;
  checkedBy: { displayNameAr: string; displayNameEn: string };
  results: { step: HardwareStep; outcome: HardwareOutcome; note: string | null }[];
  allOk: boolean;
}

export interface HardwareChecksResponse {
  /** The newest check of each PC still enrolled, newest first. */
  checks: HardwareCheck[];
  /** The steps of the PC asking. */
  steps: HardwareStep[];
}
