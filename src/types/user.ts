export const genders = [
  'male', 'female', 'unknown'
] as const;

/**
 * Union type of all possible gender values
 * 
 * Generated from the genders array to ensure type safety
 * and autocomplete support for gender selection.
 */
export type Gender = typeof genders[number];

export type KnownGender = Omit<Gender, 'unknown'>