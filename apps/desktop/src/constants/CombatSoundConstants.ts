/**
 * SFX track ids used by the combat choreography.
 *
 * They point at entries in `data/audio/sfx.yaml`; keeping the ids here stops the
 * runtime rule and the presentation layer from drifting apart.
 */

/** Played on every weapon action, whatever the weapon. */
export const WEAPON_SFX_ID = 'sword_swing';

/** Played at the impact beat when a damaging hit lands. */
export const DAMAGE_SFX_ID = 'damage';

/** Played when a unit changes battle line, at the step animation. */
export const LANE_CHANGE_SFX_ID = 'lane_change';
