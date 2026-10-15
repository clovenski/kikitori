/**
 * Cleans a source the user typed or pasted. Windows' "Copy as path" wraps the path in double quotes,
 * which would otherwise make a perfectly good file "not found".
 */
export function cleanSource(text: string): string {
  const trimmed = text.trim();
  const quoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
  return (quoted ? trimmed.slice(1, -1) : trimmed).trim();
}
