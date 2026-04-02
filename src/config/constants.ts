import { readFileSync } from "fs";
import { join } from "path";

/** Application constants and configuration */
export const APP_NAME: string = 'Twistloom';
export const APP_NAME_SLUG: string = 'twistloom';
export const WEBSITE: string = 'https://github.com/txufiknr/Twistloom';

/**
 * Safely get application version from package.json
 * @summary Gets version from npm_package_version env var or package.json file
 * @returns Version string or fallback "1.0.0"
 */
const getAppVersion = (): string => {
  try {
    if (process.env['npm_package_version']) return process.env['npm_package_version'];
    const pkgPath = join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version || "1.0.0";
  } catch {
    return "1.0.0";
  }
};

/** Application version - safely retrieved once and reused */
export const VERSION: string = getAppVersion();

/** Environment flag for development vs production behavior */
export const IS_PRODUCTION = process.env['NODE_ENV'] === "production";
export const IS_DEVELOPMENT = process.env['NODE_ENV'] === "development";
export const IS_TEST = process.env['NODE_ENV'] === "test" || process.env['NODE_ENV'] === undefined;

/** Default server port */
export const PORT: number = Number(process.env['PORT']) || 3000;