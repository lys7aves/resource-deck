export function percent(value?: number | null) { return value == null ? "—" : `${value.toFixed(value < 10 ? 1 : 0)}%`; }
export function bytes(value?: number | null) {
  if (value == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value, unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}
export function mib(value?: number | null) { return value == null ? "—" : value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value.toFixed(0)} MB`; }
