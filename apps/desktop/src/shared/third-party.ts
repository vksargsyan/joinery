import { z } from 'zod';

/**
 * The third-party licence report the renderer build writes next to its assets
 * (scripts/third-party.ts) and the About box reads (spec §20: licences audited before release).
 */

/** Served by the app protocol at `app://joinery/third-party.json`. */
export const THIRD_PARTY_REPORT = 'third-party.json';
/** The same packages as plain text with their licence and notice texts. */
export const THIRD_PARTY_NOTICES = 'THIRD_PARTY_NOTICES.txt';

/** Which part of the app a package ships in; `runtime` is Electron itself. */
export const shippedInSchema = z.enum(['main', 'preload', 'renderer', 'runtime']);
export type ShippedIn = z.infer<typeof shippedInSchema>;

export const thirdPartyPackageSchema = z.object({
  name: z.string(),
  version: z.string(),
  /** An SPDX expression from package.json, or "UNKNOWN". */
  licence: z.string(),
  homepage: z.string().optional(),
  /** The package's licence file(s). */
  licenceText: z.string().optional(),
  /** NOTICE files, which Apache-2.0 requires redistributions to carry. */
  noticeText: z.string().optional(),
  shippedIn: z.array(shippedInSchema),
  /** Absent for an npm package; `asset` for a bundled file that is not one (a font). */
  source: z.literal('asset').optional(),
});
export type ThirdPartyPackage = z.infer<typeof thirdPartyPackageSchema>;

export const thirdPartyReportSchema = z.object({
  format: z.literal(1),
  packages: z.array(thirdPartyPackageSchema),
});
export type ThirdPartyReport = z.infer<typeof thirdPartyReportSchema>;
