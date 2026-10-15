/** Decimal units, like the download pages show them (a "4.7 GB" model is 4.7 billion bytes). */
export function formatBytes(n: number): string {
  if (n <= 0) return '0 MB';
  if (n < 1e6) return '<1 MB';
  if (n < 1e9) return `${Math.round(n / 1e6)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}
