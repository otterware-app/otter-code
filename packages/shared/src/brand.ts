/**
 * Otterware shim: vendored suite modules (Otter Calendar, see
 * `scripts/otterware/vendor/`) import the scaffold's `@t3tools/shared/brand`
 * for user-facing product names. In Otterware every module shows the suite's.
 */
export const BRAND = {
  /** Product name shown to users. */
  displayName: "Otterware",
} as const;

export type Brand = typeof BRAND;
