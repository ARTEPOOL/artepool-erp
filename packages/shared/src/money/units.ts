/**
 * Scales used for every money value (decision 0014). All values are integers held as bigint:
 * - amounts and totals in fils (2 decimals): 100.50 AED = 10050n
 * - unit prices, unit costs and average cost at 4 decimals: 1.2345 AED = 12345n
 * - quantities in thousandths (3 decimals): 2.5 kg = 2500n
 * - rates in basis points: 5% = 500n
 */
export const FILS_DECIMALS = 2;
export const PRICE_DECIMALS = 4;
export const QUANTITY_DECIMALS = 3;

export const FILS_PER_AED = 100n;
export const UNITS_4DP_PER_AED = 10_000n;
export const QUANTITY_SCALE = 1_000n;
export const BASIS_POINTS = 10_000n;

/** Amount in fils (2 decimals). */
export type Fils = bigint;
/** Unit price, unit cost or average cost at 4 decimals (AED × 10,000). */
export type Amount4dp = bigint;
/** Quantity in thousandths. */
export type QuantityMilli = bigint;
/** Rate in basis points (5% = 500n). */
export type BasisPoints = bigint;
