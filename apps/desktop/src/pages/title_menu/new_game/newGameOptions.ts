import { ALLY_CONTROL_ORDER, ALLY_CONTROLS } from '../../../constants/AllyControlConstants';
import { DIFFICULTIES, DIFFICULTY_ORDER } from '../../../constants/DifficultyConstants';

/** The difficulty cards shared by the New Game wizard and the save editor. */
export const DIFFICULTY_ITEMS = DIFFICULTY_ORDER.map((difficulty) => ({
    id: difficulty,
    title: DIFFICULTIES[difficulty].title,
    description: DIFFICULTIES[difficulty].description,
}));

/** The ally-control cards shared by the New Game wizard and the save editor. */
export const ALLY_ITEMS = ALLY_CONTROL_ORDER.map((allyControl) => ({
    id: allyControl,
    title: ALLY_CONTROLS[allyControl].title,
    description: ALLY_CONTROLS[allyControl].description,
}));
