/**
 * Token <-> base-unit formatting. 1 token = 1_000_000 base units (see the
 * contract's scaling constants).
 */
export const TOKEN = 1_000_000n;

export function tokens(base: bigint | undefined | null): string {
  if (base === undefined || base === null) return '—';
  const whole = base / TOKEN;
  const frac = base % TOKEN;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

export function baseUnits(value: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!m) return null;
  const whole = BigInt(m[1]) * TOKEN;
  const frac = m[2] ? BigInt(m[2].padEnd(6, '0')) : 0n;
  return whole + frac;
}

export function feePct(bps: bigint | undefined | null): string {
  if (bps === undefined || bps === null) return '—';
  return `${Number(bps) / 100}%`;
}

export function bytesToHex(bytes: Uint8Array | undefined | null): string {
  if (!bytes) return '';
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function shortAddr(hex: string | undefined | null, n = 12): string {
  if (!hex) return '—';
  return hex.length <= n ? hex : `${hex.slice(0, n)}…`;
}