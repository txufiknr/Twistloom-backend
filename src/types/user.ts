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

/**
 * Union type of all possible like target types
 * 
 * Used for user likes system to type-safe target identification.
 */
export const likeTargetTypes = [
  'book', 'comment', 'user'
] as const;

export type LikeTargetType = typeof likeTargetTypes[number];