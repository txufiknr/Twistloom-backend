import type { InjuryCategory, BodyPartImpact, InjuryCategoryImpact } from "../types/character.js";
import type { FearLevel, MemoryIntegrity } from "../types/story.js";

export const CHARACTER_NAMES = {
  // Random name pools by gender with Gen-Z appropriate names
  maleNames: [
    'Liam', 'Noah', 'Oliver', 'Elijah', 'Lucas', 'Mason', 'Logan', 'Ethan', 'Aiden',
    'James', 'Benjamin', 'William', 'Jacob', 'Michael', 'Caleb', 'Daniel', 'Jackson',
    'Sebastian', 'Jack', 'Owen', 'Grayson', 'Julian', 'Levi', 'Mateo', 'Josiah', 'Danny',
    'Henry', 'Theodore', 'Wyatt', 'Gabriel', 'Samuel', 'Carter', 'Jayden', 'John',
    'Dylan', 'Luke', 'Asher', 'Oscar', 'Isaac', 'Parker', 'Nolan', 'Ryan', 'Peter',
    'Miles', 'Ezra', 'Hudson', 'Nathaniel', 'Connor', 'Jeremiah', 'Cameron', 'Santiago',
    'Evan', 'Angel', 'Adrian', 'Xavier', 'Kai', 'Jaxson', 'Easton', 'Everett', 'Glenn',
    'Maverick', 'Carson', 'Carl', 'Luka', 'Rowan', 'Axel', 'Bodhi', 'River', 'Cashel',
    'Kai', 'Zen', 'Phoenix', 'Orion', 'Atlas', 'Arlo', 'Sage', 'Wilder', 'Finn', 'Evander',
    'Jasper', 'Cyrus', 'Ronan', 'Zion', 'Apollo', 'Stellan', 'Caspian', 'Tyler', 'Lucian',
    'Storm', 'Blaze', 'Ace', 'Rex', 'Wolf', 'Fox', 'Hawk', 'Jett', 'Dash', 'Knox', 'Lysander',
    'Elio', 'Koa', 'Zayn', 'Kairo', 'Jax', 'Ryker', 'Zander', 'Kieran', 'Jude', 'Valen',
    'Caspian', 'Ocean', 'Forest', 'Jupiter', 'Mars', 'Mercury', 'Sol', 'Cosmo',
    'Nova', 'Sirius', 'Altair', 'Rigel', 'Vega', 'Draco', 'Leo', 'Orion', 'Cygnus',
    'Ash', 'Clay', 'Dune', 'Flint', 'Grove', 'Heath', 'Lake', 'Moss', 'Reef', 'Ralph',
    'Stone', 'Tide', 'Wave', 'Bay', 'Brook', 'Creek', 'Dale', 'Glen', 'Ridge',
    'Zephyr', 'Boreas', 'Notus', 'Eurus', 'Aeolus', 'Chinook', 'Sirocco', 'Mistral',
    'Eon', 'Epoch', 'Era', 'Aeon', 'Chronos', 'Kairos', 'Tempus', 'Hora', 'Fred',
    'Cipher', 'Nova', 'Zenon', 'Axon', 'Pixel', 'Vector', 'Matrix', 'Quantum',
    'Neo', 'Echo', 'Cipher', 'Prism', 'Flux', 'Vortex', 'Nexus', 'Vertex',
    'Onyx', 'Jet', 'Coal', 'Slate', 'Flint', 'Obsidian', 'Graphite', 'Charcoal',
    'Zenith', 'Nadir', 'Apex', 'Summit', 'Pinnacle', 'Crest', 'Peak', 'Vertex',
    'Rogue', 'Rebel', 'Maverick', 'Renegade', 'Outlaw', 'Vandal', 'Bandit', 'Ranger',
    'Saga', 'Jesse', 'Dwight', 'Jin', 'Tommy', 'Ricky', 'Bobby', 'Freddy', 'Mickey',
    'Johnny', 'Eddie', 'Tony', 'Vince', 'Frankie', 'Levy', 'Dante', 'Rico', 'Enzo',
    'Lorenzo', 'Giovanni', 'Matteo', 'Alessandro', 'Luca', 'Marco', 'Diego', 'Santino',
    'Rafael', 'Emilio', 'Salvatore', 'Antonio',
  ],

  // Male-preferring last names (stronger masculine associations)
  maleLastNames: [
    'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez',
    'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Vey',
    'Thompson', 'White', 'Harris', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker',
    'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores',
    'Green', 'Adams', 'Baker', 'Gonzalez', 'Nelson', 'Carter', 'Mitchell', 'Perez',
    'Roberts', 'Turner', 'Phillips', 'Campbell', 'Parker', 'Evans', 'Edwards', 'Collins',
    'Stewart', 'Sanchez', 'Morris', 'Rogers', 'Reed', 'Cook', 'Morgan', 'Bell', 'Murphy',
    'Bailey', 'Cooper', 'Richardson', 'Carlson', 'Cox', 'Howard', 'Ward', 'Torres', 'Peterson', 'Gray',
    'Ramirez', 'James', 'Watson', 'Brooks', 'Kelly', 'Sanders', 'Price', 'Bennett', 'Wood',
    'Barnes', 'Ross', 'Henderson', 'Coleman', 'Jenkins', 'Perry', 'Powell', 'Long', 'Patterson',
    'Hughes', 'Flores', 'Washington', 'Butler', 'Simmons', 'Foster', 'Gonzalez', 'Bryant', 'Alexander',
    'Russell', 'Griffin', 'Diaz', 'Hayes', 'Myers', 'Ford', 'Hamilton', 'Graham', 'Sullivan', 'Wallace'
  ],

  femaleNames: [
    'Olivia', 'Emma', 'Ava', 'Sophia', 'Isabella', 'Mia', 'Mira', 'Charlotte', 'Amelia',
    'Leira', 'Lennie', 'Olera', 'Lara', 'Laura', 'Sonia', 'Tania', 'Tanya', 'Monica', 'Jessica',
    'Harper', 'Evelyn', 'Abigail', 'Emily', 'Elizabeth', 'Sofia', 'Avery', 'Ella', 'Anya',
    'Madison', 'Scarlett', 'Victoria', 'Grace', 'Chloe', 'Camila', 'Penelope', 'Jane',
    'Riley', 'Zoey', 'Nora', 'Hannah', 'Lily', 'Addison', 'Aubrey', 'Ellie', 'Ellen', 'Eleanor',
    'Stella', 'Natalie', 'Zoe', 'Leah', 'Hazel', 'Violet', 'Aurora', 'Savannah', 'Liliana',
    'Audrey', 'Brooklyn', 'Bella', 'Claire', 'Skylar', 'Lucy', 'Paisley', 'Everly', 'Ashlee',
    'Anna', 'Caroline', 'Genesis', 'Emilia', 'Kennedy', 'Samantha', 'Maya', 'Mindy', 'Lydia', 'Dia',
    'Kinsley', 'Naomi', 'Aaliyah', 'Elena', 'Sarah', 'Ariana', 'Allison', 'Kara', 'Lux',
    'Mackenzie', 'Adeline', 'Vivian', 'Gianna', 'Sadie', 'Dreamy', 'Xana', 'Kaylee',
    'Gabriella', 'Alice', 'Madelyn', 'Cora', 'Ruby', 'Eva', 'Seraphina', 'Lucien', 'Emina',
    'Rose', 'Iris', 'Hazel', 'Ivy', 'Ruby', 'Dawn', 'Skye', 'Wren', 'Clara', 'Carla',
    'Poppy', 'Briar', 'Fern', 'Olive', 'Jade', 'Pearl', 'Orla', 'Hermione', 'Hilda',
    'Kehlani', 'Billie', 'Zendaya', 'Remi', 'Nyla', 'Kai', 'Indigo', 'Aurelia', 'Aurelie', 'Sienna',
    'Calliope', 'Juniper', 'Marlowe', 'Thea', 'Elodie', 'Wrenley', 'Arden', 'Loxley',
    'Sloane', 'Blair', 'Quinn', 'Reese', 'Presley', 'Rachel', 'Lena', 'Ada', 'Anita', 'Marie', 'Wendy',
    'Monroe', 'Harlow', 'Kinslee', 'Ensley', 'Finley', 'Tinsley', 'Brinley', 'Rylie',
    'Oakley', 'Ember', 'Athena', 'Freya', 'Lilith', 'Persephone', 'Katniss', 'Elize', 'Lizy',
    'Ophelia', 'Cassia', 'Seraphine', 'Evangeline', 'Genevieve', 'Maxine', 'Max', 'Michelle',
    'Juno', 'Celestia', 'Nebula', 'Solstice', 'Equinox', 'Roche', 'Velvet', 'Crimson',
    'Zenith', 'Vesper', 'Liora', 'Zara', 'Amara', 'Idris', 'Clementine', 'Marigold',
    'Primrose', 'Bluebell', 'Snowdrop', 'Lisa', 'Lavender', 'Amanda', 'Yuna', 'Katrena',
    'Aria', 'Celeste', 'Stella', 'Luna', 'Aurora', 'Vega', 'Nova', 'Lyra', 'Kael', 'Orion',
    'Serenity', 'Harmony', 'Melody', 'Rhythm', 'Cadence', 'Lyric', 'Sonnet', 'Verse',
    'Willow', 'Ivy', 'Briar', 'Meadow', 'Daisy', 'Clover', 'Sage', 'Hazel',
    'Ocean', 'River', 'Rain', 'Storm', 'Sky', 'Star', 'Moon', 'Sun', 'Cloud', 'Angie', 'Lou',
    'Zephyr', 'Breeze', 'Gale', 'Mist', 'Dew', 'Frost', 'Snow', 'Ice', 'Crystal',
    'Phoenix', 'Raven', 'Wren', 'Dove', 'Jules', 'Verne', 'Velma', 'Jennifer',
    'Onyx', 'Jade', 'Ruby', 'Pearl', 'Amber', 'Garnet', 'Opal', 'Topaz', 'Emerald',
    'Zion', 'Eden', 'Arcadia', 'Shangri-La', 'Utopia', 'Elysium', 'Valhalla', 'Olympus',
    'Electra', 'Cassiopeia', 'Callisto', 'Europa', 'Io', 'Ganymede', 'Gina',
    'Xena', 'Artemis', 'Athena', 'Hera', 'Persephone', 'Demeter', 'Hestia', 'Nike',
    'Valkyrie', 'Amazon', 'Siren', 'Nymph', 'Muse', 'Fury', 'Grave', 'Destiny', 'Donna',
    'Echo', 'Nyx', 'Selene', 'Aurora', 'Eos', 'Hemera', 'Thalia', 'Idalia', 'Judy', 'Judith',
    'Calypso', 'Circe', 'Medea', 'Hecate', 'Rhea', 'Dione', 'Solenne', 'Zora', 'Liora', 'Vesper',
    'Zenith', 'Nadir', 'Summit', 'Pinnacle', 'Crest', 'Peak', 'Vertex', 'Rogue', 'Rebel', 'Maverick',
    'Renegade', 'Outlaw', 'Vandal', 'Myth', 'Fable', 'Kaia', 'Nyla', 'Zara', 'Veda', 'Sia', 'Kora',
    'Mila', 'Nia', 'Aaliyah', 'Anaya', 'Aziza', 'Bria', 'Cia', 'Dara', 'Elina', 'Fara',
    'Zuri', 'Nia', 'Zola', 'Kendi', 'Makena', 'Nala', 'Zara', 'Yara', 'Zephyrine', 'Zinnia',
    'Zelda', 'Zahara', 'Zaylee', 'Zadie', 'Zella', 'Zuri', 'Zayla', 'Zayda',
  ],

  femaleLastNames: [
    'Rose', 'Hazel', 'Ivy', 'Ruby', 'Dawn', 'Skye', 'Blackwood', 'Petrova', 'Hart',
    'Bloom', 'Winters', 'Summers', 'Bliss', 'Grace', 'Hope', 'Joy', 'Faith', 'Love', 'Star',
    'Angel', 'Dream', 'Moon', 'Sun', 'Cloud', 'Rain', 'Storm', 'Blaze', 'Frost', 'Snow', 'Voss',
    'Meadow', 'Brook', 'River', 'Ocean', 'Wave', 'Breeze', 'Dew', 'Mist', 'Crystal', 'Pearl',
    'Iris', 'Lily', 'Daisy', 'Tulip', 'Violet', 'Poppy', 'Marigold', 'Azalea', 'Camellia', 'Jasmine',
    'Rosewood', 'Moonlight', 'Starlight', 'Sunshine', 'Rainbow', 'Butterfly', 'Phoenix', 'Serenity',
    'Harmony', 'Melody', 'Rhythm', 'Cadence', 'Lyric', 'Sonnet', 'Poem', 'Verse', 'Story', 'Tale',
    'Whisper', 'Echo', 'Silence', 'Calm', 'Peace', 'Zen', 'Bliss', 'Joy', 'Glee', 'Cheer', 'Vera',
    'Sparkle', 'Glitter', 'Shimmer', 'Glimmer', 'Glow', 'Shine', 'Bright', 'Radiant', 'Luminous',
    'Celeste', 'Stella', 'Nova', 'Luna', 'Aurora', 'Orion', 'Vega', 'Lyra', 'Cassiopeia', 'Carinae',
    'Meteora', 'Lynn', 'Nyx', 'Patel', 'Shah', 'Verma', 'Malhotra', 'Agarwal', 'Jain', 'Gabriela',
    'Rosa', 'Maria', 'Sofia', 'Isabella', 'Catalina', 'Valentina', 'Emilia', 'Camila', 'Lucia',
    'Yoon', 'Lim', 'Han', 'Shin', 'Chen', 'Apolonia', 'Cassiopeia', 'Lunaria', 'Stellaria',
    'Garcia', 'Rivera', 'Oliveira', 'Ferreira', 'Costa', 'Almeida', 'Rocha', 'Lou'
  ],

  // Gender-neutral last names (modern and Gen-Z appropriate)
  neutralLastNames: [
    'Stone', 'Wolf', 'Fox', 'Hawk', 'Raven', 'Crow', 'Phoenix', 'Falcon', 'Eagle', 'Hawk', 'Fable',
    'River', 'Brook', 'Stone', 'Rock', 'Cliff', 'Ridge', 'Peak', 'Summit', 'Valley', 'Meadow', 'Lark',
    'Wolf', 'Bear', 'Lion', 'Tiger', 'Eagle', 'Hawk', 'Falcon', 'Raven', 'Crow', 'Phoenix', 'Reverie',
    'Storm', 'Blaze', 'Frost', 'Ice', 'Snow', 'Rain', 'Thunder', 'Lightning', 'Shadow', 'Night',
    'Star', 'Moon', 'Sun', 'Sky', 'Cloud', 'Wind', 'Earth', 'Fire', 'Water', 'Spirit', 'Sylvan',
    'Silver', 'Gold', 'Bronze', 'Copper', 'Steel', 'Iron', 'Crystal', 'Diamond', 'Ruby', 'Jade',
    'Rowan', 'Sage', 'Wren', 'Linden', 'Indigo', 'Marlowe', 'August', 'Sawyer', 'Robin', 'Taylor',
    'Morgan', 'Casey', 'Drew', 'Jamie', 'Jordan', 'Taylor', 'Logan', 'Casey', 'Dakota', 'River',
    'August', 'Sage', 'Wren', 'Linden', 'Indigo', 'Marlowe', 'Rowan', 'Robin', 'Taylor', 'Morgan'
  ]
}

/** Never generate a character with these names. */
export const blacklistedNames: string[] = [
  // AI-memes
  'Elara',
  'Elias',
  'Vance',
  'Voss',
  'Thorne',
  'Julian',
  'Silas',
  // Religious & sensitive names
  'Muhammad'
];

// ============================================================================
// INJURY IMPACT CONFIGURATION
// ============================================================================

/**
 * Per-dimension impact weights for each injury category.
 *
 * `physical` is a uniform multiplier applied to health, mobility, and action
 * damage — a fracture is categorically more limiting than a bruise across all
 * physical axes, regardless of which body part is affected.
 *
 * `mental` is independent, capturing each category's distinct psychological
 * weight. Burns and poison spike mental damage because of the psychological
 * horror of helplessness and disfigurement. `psychological` is the primary
 * mental horror axis: near-zero physical, maximum mental.
 *
 * Calibration guide (see also `*_SCORE_CAP` constants in `characters.ts`):
 * - Increase `physical` → category feels more damaging to health/mobility/action.
 * - Increase `mental`   → category contributes more to psychological breakdown.
 */
export const INJURY_CATEGORY_WEIGHTS: Record<InjuryCategory, InjuryCategoryImpact> = {
  bruise:        { physical: 0.4, mental: 0.2 },  // Minor; quick to dismiss, easy to ignore
  cut:           { physical: 1.0, mental: 0.5 },  // Baseline physical injury
  fracture:      { physical: 1.4, mental: 0.8 },  // Significantly limiting; the pain is constant
  burn:          { physical: 1.2, mental: 1.5 },  // Scarring & disfigurement are psychologically traumatic
  internal:      { physical: 2.0, mental: 1.0 },  // Severe systemic risk; invisible and frightening
  poison:        { physical: 1.8, mental: 1.8 },  // Helplessness + uncertainty amplify mental impact
  infection:     { physical: 1.5, mental: 0.8 },  // Progressive threat; dread from slow deterioration
  exhaustion:    { physical: 0.8, mental: 1.5 },  // Physical toll is mild; mental erosion is severe
  psychological: { physical: 0.3, mental: 3.0 },  // The primary horror axis: minimal body, maximum mind
};

/**
 * Per-dimension impact weights for each body part.
 *
 * Four axes, each independently tuned for psychological thriller gameplay:
 *
 * - `health`   — systemic vitality drain (how dangerous is damage here?)
 * - `mobility` — ability to flee, run, climb (thriller escape axis)
 * - `action`   — ability to use hands/arms/tools (thriller agency axis)
 * - `trauma`   — psychological weight of being injured here (horror axis)
 *
 * **Thriller design principles applied:**
 * - Leg/knee injuries dominate `mobility` — being unable to flee is the
 *   primary fear vector in a pursuit thriller.
 * - Hand/shoulder/wrist injuries dominate `action` — the MC's agency
 *   depends on being able to manipulate objects, open doors, and climb.
 * - Head/eye/neck injuries spike both `health` and `trauma` — concussions
 *   disorient, eye loss is devastating, near-fatal neck wounds are primal horror.
 * - `heart` and `lung` weights are extreme by design: in a thriller these
 *   represent narrative extremes (near-death states), correctly zeroing out
 *   health and mobility when the MC is on the brink.
 * - Psychological body parts (`mind`, `psyche`) have near-zero physical
 *   dimensions and high `trauma`, pairing with the `psychological` category
 *   to cleanly drive the mental axis without contaminating physical stats.
 *
 * **Substring matching:** `getBodyPartImpact` first tries exact match, then
 * scans keys longest-first for substring presence. This means "left knee",
 * "right knee", "lower back", "ring finger" all correctly resolve to their
 * canonical entry without needing every variant enumerated explicitly.
 */
export const BODY_PART_WEIGHTS: Record<string, BodyPartImpact> = {
  // ── Head & neck ────────────────────────────────────────────────────────────
  // High health risk and high trauma; moderate mobility/action impairment
  // (concussions disorient; vertigo slows action; neck wounds are primal horror)
  head:     { health: 2.0, mobility: 0.5,  action: 0.8,  trauma: 2.0 },
  skull:    { health: 2.0, mobility: 0.5,  action: 0.8,  trauma: 2.0 }, // alias
  face:     { health: 1.2, mobility: 0.2,  action: 0.3,  trauma: 1.8 }, // disfigurement → horror
  eye:      { health: 1.5, mobility: 0.8,  action: 0.9,  trauma: 2.5 }, // vision loss = extreme capability loss
  neck:     { health: 2.2, mobility: 0.6,  action: 0.4,  trauma: 2.0 }, // near-fatal; primal vulnerability

  // ── Torso ──────────────────────────────────────────────────────────────────
  // High health risk; chest/lung injuries impair mobility via breathing pain
  chest:    { health: 1.8, mobility: 1.2,  action: 0.5,  trauma: 1.2 }, // every breath is a reminder
  heart:    { health: 3.0, mobility: 2.0,  action: 1.0,  trauma: 2.0 }, // narrative extreme: near-instant critical
  lung:     { health: 2.5, mobility: 2.0,  action: 0.5,  trauma: 1.5 }, // breathing difficulty → can't run
  ribs:     { health: 1.3, mobility: 1.2,  action: 0.5,  trauma: 0.8 }, // pain on movement; stifles fleeing
  abdomen:  { health: 1.6, mobility: 1.0,  action: 0.5,  trauma: 1.0 },
  stomach:  { health: 1.4, mobility: 0.8,  action: 0.3,  trauma: 0.8 },
  torso:    { health: 1.5, mobility: 1.0,  action: 0.5,  trauma: 0.8 }, // generic torso fallback

  // ── Back & spine ───────────────────────────────────────────────────────────
  // Back pain radiates to limbs; spinal damage is catastrophic for mobility
  back:     { health: 1.2, mobility: 1.8,  action: 0.8,  trauma: 0.8 },
  spine:    { health: 2.0, mobility: 2.5,  action: 0.8,  trauma: 2.0 }, // paralysis risk

  // ── Upper limbs (action-critical) ─────────────────────────────────────────
  // Shoulders/hands/wrists dominate the action axis.
  // In a thriller the MC's hands are everything: locks, tools, phones, climbing.
  shoulder: { health: 0.9, mobility: 0.3,  action: 1.8,  trauma: 0.6 },
  arm:      { health: 0.8, mobility: 0.2,  action: 1.5,  trauma: 0.5 },
  elbow:    { health: 0.7, mobility: 0.2,  action: 1.2,  trauma: 0.4 },
  wrist:    { health: 0.5, mobility: 0.1,  action: 1.5,  trauma: 0.5 },
  hand:     { health: 0.6, mobility: 0.1,  action: 1.8,  trauma: 0.6 },
  finger:   { health: 0.2, mobility: 0.0,  action: 0.8,  trauma: 0.4 },

  // ── Lower limbs (mobility-critical) ────────────────────────────────────────
  // Knee injuries are the single highest mobility penalty: a blown knee
  // makes the MC nearly immobile — they cannot flee, cannot climb, cannot run.
  // This is a deliberate thriller design choice.
  hip:      { health: 1.0, mobility: 2.2,  action: 0.3,  trauma: 0.7 },
  leg:      { health: 1.0, mobility: 2.5,  action: 0.2,  trauma: 0.6 },
  knee:     { health: 1.2, mobility: 3.0,  action: 0.1,  trauma: 0.7 }, // highest mobility penalty
  ankle:    { health: 0.8, mobility: 2.2,  action: 0.1,  trauma: 0.5 },
  foot:     { health: 0.6, mobility: 1.8,  action: 0.1,  trauma: 0.4 },

  // ── Psychological body parts ────────────────────────────────────────────────
  // Near-zero physical dimensions; high trauma.
  // Used when AI assigns "mind" or "psyche" as bodyPart on psychological injuries.
  // The `psychological` category's mental:3.0 × trauma:1.5 still produces significant
  // mental damage without creating a runaway multiplier stack.
  mind:     { health: 0.3, mobility: 0.1,  action: 0.3,  trauma: 1.5 },
  psyche:   { health: 0.3, mobility: 0.1,  action: 0.3,  trauma: 1.5 },
};

/**
 * Maximum total damage score that reduces a given stat to 0%.
 *
 * These constants are the primary tuning levers for difficulty feel:
 * - Raise a cap  → injuries feel lighter (harder to bottom out that stat).
 * - Lower a cap  → injuries feel more punishing (easier to reach 0%).
 *
 * Reference calibration scenarios:
 *
 * HEALTH_SCORE_CAP = 6.0
 *   A single severe internal head injury (0.9 × physical:2.0 × health:2.0 = 3.6)
 *   drops healthPercent to ~40% (wounded). Three such injuries bottom it out.
 *   A minor arm bruise (0.2 × 0.4 × 0.8 = 0.064) barely registers at ~99%.
 *
 * MOBILITY_SCORE_CAP = 4.0
 *   A fractured knee (0.8 × physical:1.4 × mobility:3.0 = 3.36) → ~16% mobility.
 *   The MC can barely stand, let alone flee — correct for a psychological thriller.
 *   A twisted ankle bruise (0.3 × 0.4 × 2.2 = 0.264) → ~93% mobility (mild limp).
 *
 * ACTION_SCORE_CAP = 4.0
 *   A severe shoulder fracture (0.7 × 1.4 × 1.8 = 1.764) → ~56% actionPercent.
 *   The MC can still function but reaching overhead or defending is painful.
 *
 * MENTAL_SCORE_CAP = 8.0
 *   Absolute worst case: corrupted memory (2.0) + 10 trauma tags (1.2)
 *   + high fear (0.4) + severe psychological injury to head (0.9 × 3.0 × 2.0 = 5.4)
 *   = 9.0 → clamped to 0%. Mid-game fragmented memory + 4 tags + medium fear
 *   alone gives ~78% mental — noticeably affected but still coherent.
 */
export const HEALTH_SCORE_CAP   = 6.0;
export const MOBILITY_SCORE_CAP = 4.0;
export const ACTION_SCORE_CAP   = 4.0;
export const MENTAL_SCORE_CAP   = 8.0;

/**
 * Fallback impact used for body part strings that don't match any known key.
 *
 * Represents a generic body area injury: moderate contribution to health,
 * mild movement and action penalties, moderate psychological weight.
 * Exhaustion injuries that carry no specific body part resolve here cleanly.
 */
export const DEFAULT_BODY_PART_IMPACT: BodyPartImpact = {
  health:   1.0,
  mobility: 0.5,
  action:   0.5,
  trauma:   0.5,
};

/**
 * Mental penalty applied per memory integrity level.
 * Stable memory contributes nothing; corrupted memory is a severe baseline hit.
 */
export const MEMORY_INTEGRITY_MENTAL_PENALTY: Record<MemoryIntegrity, number> = {
  stable:     0.0,
  fragmented: 0.8,
  corrupted:  2.0,
};

/**
 * Mental penalty applied per fear flag level.
 * Fear state adds a smaller but persistent mental burden on top of structural sources.
 */
export const FEAR_MENTAL_PENALTY: Record<FearLevel, number> = {
  low:    0.0,
  medium: 0.2,
  high:   0.4,
};

/**
 * Per-trauma-tag contribution to mental damage.
 * Ten accumulated trauma tags add 1.2 to the mental score (15% of the cap).
 */
export const TRAUMA_TAG_MENTAL_WEIGHT = 0.12;
