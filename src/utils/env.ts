export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

export function getEnv(name: string, defaultValue?: string): string {
  const v = process.env[name];
  if (!v && defaultValue === undefined && process.env.NODE_ENV !== 'test') {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return v || defaultValue || '';
}