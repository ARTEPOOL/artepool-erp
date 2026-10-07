/** Raised when a text value is not a valid amount, price or quantity. */
export class MoneyFormatError extends Error {
  readonly code = 'MONEY_FORMAT';
  override readonly name = 'MoneyFormatError';
}

/** Raised when a calculation would break a money rule (e.g. a discount larger than the line). */
export class MoneyRuleError extends Error {
  readonly code = 'MONEY_RULE';
  override readonly name = 'MoneyRuleError';
}
