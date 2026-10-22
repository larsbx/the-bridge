// Display only. Aggregation and accounting remain in Bridge.Snapshot.
export function money(value, currency) {
  if (value === null) return 'Unavailable';
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe cent value');
  const amount = BigInt(value);
  const cents = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '−' : ''}${currency || 'Unknown currency'} ${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export const magnitude = value => { const amount = BigInt(value); return amount < 0n ? -amount : amount; };
