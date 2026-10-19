/** Short, URL safe ids: `ban_1f3c...`. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}
