// Адрес агента берём из адреса, с которого открыт чат: http://192.168.x.x:3000, ссылка туннеля
// или localhost. Тогда чат работает с любого адреса ПК и не зависит от того, что записано в ui/.env
export function resolveApiUrl(queryApiUrl: string, envApiUrl?: string): string {
  if (typeof window !== "undefined") return `${window.location.origin}/api`;
  return envApiUrl || queryApiUrl;
}
