/**
 * Capitalizes the first letter of a string
 * @param str - The string to format
 * @returns The string with the first letter capitalized
 */
export function ucfirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Creates a safe filename by removing invalid characters and replacing spaces with underscores
 * @param filename - The original filename to sanitize
 * @returns Safe filename suitable for file system
 */
export function sanitizeFilename(filename: string): string {
  return filename
    // Remove or replace invalid characters for filenames
    .replace(/[<>:"/\\|?*]/g, '') // Remove < > : " / \ | ? * 
    .replace(/&/g, '') // Remove ampersands (problematic for URLs/file systems)
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/_{2,}/g, '_') // Replace multiple underscores with single
    .replace(/^_+|_+$/g, '') // Remove leading/trailing underscores
    .toLowerCase(); // Convert to lowercase for URL consistency
}
