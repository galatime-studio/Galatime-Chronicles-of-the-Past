/**
 * Offline weight optimizer for the Utility AI.
 *
 * The optimizer searches the consideration weights; it never selects an action
 * itself. Every candidate is evaluated by routing it through `decideWithAiWeights`
 * and the ordinary headless combat runner, so the same combat rules, targeting
 * validation and resource costs apply as in a live fight.
 *
 * The search is a bounded cross-entropy method (CEM): sample a population around
 * the current mean, keep the elite, refit the mean/std and repeat. Candidates are
 * compared against a fixed opponent on paired seeds and on both sides of every
 * scenario, which removes the side bias of self-play.
 */

import { DEFAULT_AI_WEIGHTS } from '../../../../constants/AiConstants';
import {
    AI_CONSIDERATION_IDS,
    AI_SETUP_FOLLOWUP_TURNS,
    AI_WEIGHT_FLOORS,
    AI_WEIGHT_MAX,
    AI_WEIGHT_MIN,
} from '../../../../constants/AiTrainingConstants';
import type { Difficulty } from '../../../../constants/DifficultyConstants';
import type { AiConsiderationId, AiWeights } from '../../../../types/AiType';
import type {
    AiBatchPolicy,
    AiHeadlessActionPolicy,
    AiOptimizerGeneration,
    AiScenarioFormation,
    AiTrainingScenario,
    AiTurnHistoryEntry,
    AiWeightEvaluation,
    AiWeightOptimizationReport,
    AiWeightOptimizerOptions,
} from '../../../../types/AiTrainingType';
import type { CombatSide, CombatUnit } from '../../../../types/CombatType';
import { clamp } from '../../../../utils/combatUtils';
import { resetHeadlessSessions, runHeadlessCombat } from './headlessRunner';
import { createSeededCombatRandom, hashAiSeed } from './seededRandom';
import { decideWithAiWeights } from './weightAdapter';

/** Dimensions that never influence a legal AI choice in the current harness. */
const FROZEN_CONSIDERATIONS: readonly AiConsiderationId[] = ['flee'];

/**
 * Fitness weights. A win dominates and HP/kills break draws. Draws, overtime and
 * stalemates are three flavours of "failed to finish"; a stall is a harness
 * failure and is penalised as such.
 *
 * The follow-up term exists because every other term pays for damage now. It
 * pays for a setup the side actually cashed in, which is the only dense
 * evidence that a turn spent on the future was spent well: the mechanical
 * `exploits` channel needs explicit payoff fields and fires almost never on
 * synthetic content, and mere status presence is set by the scenario, not by
 * the policy.
 */
const HP_MARGIN_WEIGHT = 0.35;
const KILL_MARGIN_WEIGHT = 0.15;
const DRAW_PENALTY = 0.25;
const PACE_PENALTY = 0.25;
const STALEMATE_PENALTY = 0.35;
const STALL_PENALTY = 1.5;
const SETUP_FOLLOWUP_WEIGHT = 0.2;

const DEFAULT_VALIDATION_PATIENCE = 3;

interface EvaluationOptions {
    scenarios: readonly AiTrainingScenario[];
    opponent: AiBatchPolicy;
    repetitions: number;
    difficulty: Difficulty;
}

interface EvaluatedCandidate {
    weights: AiWeights;
    values: number[];
    train: AiWeightEvaluation;
}

function otherSide(side: CombatSide): CombatSide {
    return side === 'allies' ? 'enemies' : 'allies';
}

function protagonistSide(scenario: AiTrainingScenario): CombatSide {
    return scenario.units.find((unit) => unit.isPlayerControlled)?.side ?? 'allies';
}

function weightOf(weights: AiWeights, id: AiConsiderationId): number {
    return weights[id] ?? DEFAULT_AI_WEIGHTS[id] ?? 0;
}

/** Lower search bound for one dimension; frozen ids are excluded by the caller. */
function floorOf(id: AiConsiderationId): number {
    return clamp(AI_WEIGHT_FLOORS[id] ?? AI_WEIGHT_MIN, AI_WEIGHT_MIN, AI_WEIGHT_MAX);
}

function normalizeWeights(raw: AiWeights): AiWeights {
    const weights = {} as AiWeights;
    for (const id of AI_CONSIDERATION_IDS) {
        weights[id] = clamp(weightOf(raw, id), floorOf(id), AI_WEIGHT_MAX);
    }
    return weights;
}

function fullWeights(
    baseline: AiWeights,
    activeIds: readonly AiConsiderationId[],
    values: readonly number[],
): AiWeights {
    const weights = { ...baseline };
    activeIds.forEach((id, index) => {
        weights[id] = clamp(values[index] ?? weightOf(baseline, id), floorOf(id), AI_WEIGHT_MAX);
    });
    return weights;
}

function activeValues(
    weights: AiWeights,
    activeIds: readonly AiConsiderationId[],
): number[] {
    return activeIds.map((id) => weightOf(weights, id));
}

function createHeadlessPolicy(weights: AiWeights): AiHeadlessActionPolicy {
    return {
        selectAction: (observation) => decideWithAiWeights(observation.context, weights).request,
    };
}

function wilsonInterval(wins: number, battles: number): [number, number] {
    if (battles <= 0) return [0, 0];
    const z = 1.96;
    const p = wins / battles;
    const denominator = 1 + (z * z) / battles;
    const centre = (p + (z * z) / (2 * battles)) / denominator;
    const half = (z * Math.sqrt((p * (1 - p)) / battles + (z * z) / (4 * battles * battles)))
        / denominator;
    return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function candidateDamage(units: readonly CombatUnit[], metricsDamage: Record<string, number>, side: CombatSide): number {
    let total = 0;
    for (const unit of units) {
        if (unit.side === side) total += metricsDamage[unit.id] ?? 0;
    }
    return total;
}

function candidateKills(units: readonly CombatUnit[], metricsKills: Record<string, number>, side: CombatSide): number {
    let total = 0;
    for (const unit of units) {
        if (unit.side === side) total += metricsKills[unit.id] ?? 0;
    }
    return total;
}

function healthFraction(unit: CombatUnit): number {
    if (unit.status !== 'alive') return 0;
    const maxHp = Math.max(1, unit.stats.maxHp);
    return clamp(unit.currentHp / maxHp, 0, 1);
}

function sideHealthAverage(units: readonly CombatUnit[], side: CombatSide): number {
    let count = 0;
    let total = 0;
    for (const unit of units) {
        if (unit.side !== side) continue;
        count += 1;
        total += healthFraction(unit);
    }
    return count > 0 ? total / count : 0;
}

function sideCount(units: readonly CombatUnit[], side: CombatSide): number {
    return units.reduce((total, unit) => total + (unit.side === side ? 1 : 0), 0);
}

function sideDefeated(units: readonly CombatUnit[], side: CombatSide): number {
    return units.reduce((total, unit) => (
        total + (unit.side === side && unit.status !== 'alive' ? 1 : 0)
    ), 0);
}

/**
 * Counts what one side set up and later cashed in.
 *
 * `setups` and `exploits` are diagnostics; the fitness-driving numbers are
 * `followedSetups` (a setup on a target that the same side hits within
 * `AI_SETUP_FOLLOWUP_TURNS` of its own turns) and the leverage pair
 * (`attackTurns` vs `leverageTurns`), because the mechanical exploit records
 * need explicit payoff fields that synthetic skills rarely carry.
 */
function planningCounts(
    history: readonly AiTurnHistoryEntry[],
    side: CombatSide,
): {
    setups: number;
    exploits: number;
    attackTurns: number;
    leverageTurns: number;
    followedSetups: number;
} {
    let setups = 0;
    let exploits = 0;
    let attackTurns = 0;
    let leverageTurns = 0;
    let followedSetups = 0;
    let sideTurn = -1;
    const pending: { targetId: string; turn: number }[] = [];
    for (const entry of history) {
        if (entry.actorSide === side) sideTurn += 1;
        for (const setup of entry.setups) {
            if (setup.sourceSide !== side) continue;
            setups += 1;
            pending.push({ targetId: setup.targetId, turn: sideTurn });
        }
        for (const exploit of entry.exploits) {
            if (exploit.attackerSide === side) exploits += 1;
        }
        if (!entry.action?.dealsDamage) continue;
        if (entry.actorSide === side) attackTurns += 1;
        if (entry.statusLeverage) leverageTurns += 1;
        if (entry.actorSide !== side) continue;
        const targets = new Set(entry.targetIds);
        for (let index = pending.length - 1; index >= 0; index -= 1) {
            const item = pending[index];
            const age = sideTurn - item.turn;
            if (age > AI_SETUP_FOLLOWUP_TURNS) {
                pending.splice(index, 1);
                continue;
            }
            if (age < 1 || !targets.has(item.targetId)) continue;
            followedSetups += 1;
            pending.splice(index, 1);
        }
    }
    return { setups, exploits, attackTurns, leverageTurns, followedSetups };
}

/**
 * Evaluates one weight vector against a fixed opponent on every scenario, on
 * both sides, with paired seeds. The same battle seed is used for every
 * candidate, so comparisons are paired rather than merely repeated.
 */
async function evaluateWeights(
    weights: AiWeights,
    options: EvaluationOptions,
): Promise<AiWeightEvaluation> {
    const candidate = createHeadlessPolicy(weights);
    let battles = 0;
    let wins = 0;
    let losses = 0;
    let draws = 0;
    let stalls = 0;
    let stalemates = 0;
    let maxTurns = 0;
    let combatEnded = 0;
    let turnsSum = 0;
    let paceSum = 0;
    let damageSum = 0;
    let killsSum = 0;
    let hpMarginSum = 0;
    let killMarginSum = 0;
    let setupSum = 0;
    let exploitSum = 0;
    let attackTurnSum = 0;
    let leverageTurnSum = 0;
    let followedSetupSum = 0;

    resetHeadlessSessions();
    try {
        for (const scenario of options.scenarios) {
            for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
                const baseSeed = `${scenario.seed}:${repetition}`;
                for (const candidateIsProtagonist of [true, false]) {
                    const seed = `${baseSeed}:${candidateIsProtagonist ? 'main' : 'swapped'}`;
                    try {
                        const result = candidateIsProtagonist
                            ? await runHeadlessCombat({
                                scenario,
                                policy: candidate,
                                opponentPolicy: options.opponent.policy,
                                seed,
                                difficulty: options.difficulty,
                            })
                            : await runHeadlessCombat({
                                scenario,
                                policy: options.opponent.policy,
                                opponentPolicy: candidate,
                                seed,
                                difficulty: options.difficulty,
                            });

                        const side = candidateIsProtagonist
                            ? protagonistSide(scenario)
                            : otherSide(protagonistSide(scenario));
                        const units = result.state.units;

                        battles += 1;
                        turnsSum += result.metrics.turns;
                        paceSum += result.metrics.turns
                            / Math.max(1, scenario.expectedRounds * scenario.units.length);
                        damageSum += candidateDamage(units, result.metrics.damageByUnit, side);
                        killsSum += candidateKills(units, result.metrics.killsByUnit, side);

                        if (!result.metrics.winningSide) {
                            draws += 1;
                        } else if (result.metrics.winningSide === side) {
                            wins += 1;
                        } else {
                            losses += 1;
                        }

                        if (result.stoppedReason === 'stall') stalls += 1;
                        else if (result.stoppedReason === 'stalemate') stalemates += 1;
                        else if (result.stoppedReason === 'max_turns') maxTurns += 1;
                        else combatEnded += 1;

                        const ownHealth = sideHealthAverage(units, side);
                        const otherHealth = sideHealthAverage(units, otherSide(side));
                        hpMarginSum += ownHealth - otherHealth;

                        const ownCount = Math.max(1, sideCount(units, side));
                        const otherCount = Math.max(1, sideCount(units, otherSide(side)));
                        const ownKills = sideDefeated(units, otherSide(side));
                        const otherKills = sideDefeated(units, side);
                        killMarginSum += ownKills / otherCount - otherKills / ownCount;

                        const planning = planningCounts(result.history, side);
                        setupSum += planning.setups;
                        exploitSum += planning.exploits;
                        attackTurnSum += planning.attackTurns;
                        leverageTurnSum += planning.leverageTurns;
                        followedSetupSum += planning.followedSetups;
                    } catch {
                        // A harness crash is a failed battle, not a reason to lose the
                        // whole search. It is penalised exactly like a stall.
                        battles += 1;
                        stalls += 1;
                    }
                }
            }
        }
    } finally {
        resetHeadlessSessions();
    }

    const safeBattles = Math.max(1, battles);
    const winRate = wins / safeBattles;
    const avgHpMargin = hpMarginSum / safeBattles;
    const avgKillMargin = killMarginSum / safeBattles;
    const drawRate = draws / safeBattles;
    const stalemateRate = stalemates / safeBattles;
    const stallRate = stalls / safeBattles;
    const avgPace = paceSum / safeBattles;
    // Only overrunning the calibrated length is penalised; finishing early is
    // already rewarded by the win rate.
    const overtime = clamp(avgPace - 1, 0, 1);
    const avgSetups = setupSum / safeBattles;
    const avgExploits = exploitSum / safeBattles;
    // Conversion is only meaningful against work the side actually did: a
    // status inherited from the opening loadout is not planning.
    const setupConversion = avgSetups <= 0 ? 0 : clamp(avgExploits / avgSetups, 0, 1);
    const statusLeverage = attackTurnSum <= 0
        ? 0
        : clamp(leverageTurnSum / attackTurnSum, 0, 1);
    const setupFollowUp = setupSum <= 0
        ? 0
        : clamp(followedSetupSum / setupSum, 0, 1);
    const fitness = winRate
        + HP_MARGIN_WEIGHT * avgHpMargin
        + KILL_MARGIN_WEIGHT * avgKillMargin
        - DRAW_PENALTY * drawRate
        - PACE_PENALTY * overtime
        - STALEMATE_PENALTY * stalemateRate
        - STALL_PENALTY * stallRate
        + SETUP_FOLLOWUP_WEIGHT * setupFollowUp;

    return {
        battles,
        wins,
        losses,
        draws,
        stalls,
        stalemates,
        maxTurns,
        combatEnded,
        winRate,
        winRateCi: wilsonInterval(wins, battles),
        avgTurns: turnsSum / safeBattles,
        avgPace,
        avgDamage: damageSum / safeBattles,
        avgKills: killsSum / safeBattles,
        avgHpMargin,
        avgKillMargin,
        avgSetups,
        avgExploits,
        setupConversion,
        statusLeverage,
        setupFollowUp,
        fitness,
    };
}

function sampleGaussian(random: () => number): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = random();
    while (v === 0) v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function average(values: readonly number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values: readonly number[], mean: number): number {
    if (values.length === 0) return 0;
    const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
}

/**
 * Runs the CEM search. The train split is the only split that drives the
 * distribution; validation selects/early-stops and test is measured once at the
 * end. Returned weights always satisfy the 14-column harness contract.
 */
export async function optimizeAiWeights(
    options: AiWeightOptimizerOptions,
): Promise<AiWeightOptimizationReport> {
    if (options.scenarios.length === 0) throw new Error('The optimizer needs at least one training scenario.');
    if (!options.opponent) throw new Error('The optimizer needs a fixed opponent.');

    const baseline = normalizeWeights(options.baseline ?? DEFAULT_AI_WEIGHTS);
    const activeIds = [...(options.activeConsiderationIds
        ?? AI_CONSIDERATION_IDS.filter((id) => !FROZEN_CONSIDERATIONS.includes(id)))];
    if (activeIds.length === 0) throw new Error('The optimizer needs at least one active consideration.');

    const repetitions = Math.max(1, options.repetitions ?? 1);
    const difficulty = options.difficulty ?? 'hard';
    const generations = Math.max(1, options.generations ?? 5);
    const populationSize = Math.max(2, options.populationSize ?? 8);
    const eliteFraction = clamp(options.eliteFraction ?? 0.3, 0.1, 1);
    const eliteCount = Math.max(1, Math.min(populationSize, Math.ceil(populationSize * eliteFraction)));
    const initialStd = Math.max(0, options.initialStd ?? 0.6);
    const minStd = Math.max(0, options.minStd ?? 0.05);
    const validationPatience = Math.max(1, options.validationPatience ?? DEFAULT_VALIDATION_PATIENCE);
    const seed = hashAiSeed(options.seed ?? 'ai-weight-optimizer');
    const random = createSeededCombatRandom(`${seed}:optimizer`);
    const evaluationOptions: EvaluationOptions = {
        scenarios: options.scenarios,
        opponent: options.opponent,
        repetitions,
        difficulty,
    };

    console.log(`[optimizer] evaluating baseline on ${options.scenarios.length} train scenario(s)…`);
    const baselineTrain = await evaluateWeights(baseline, evaluationOptions);
    const baselineValidation = options.validation && options.validation.length > 0
        ? await evaluateWeights(baseline, { ...evaluationOptions, scenarios: options.validation })
        : null;
    let best: { weights: AiWeights; train: AiWeightEvaluation; validation: AiWeightEvaluation | null } = {
        weights: baseline,
        train: baselineTrain,
        validation: baselineValidation,
    };
    let bestValidationFitness = baselineValidation?.fitness ?? -Number.POSITIVE_INFINITY;
    let validationStale = 0;
    let bestTrain: { weights: AiWeights; fitness: number } = {
        weights: baseline,
        fitness: baselineTrain.fitness,
    };

    let mean = activeValues(baseline, activeIds);
    let std = activeIds.map(() => initialStd);
    const history: AiOptimizerGeneration[] = [];

    for (let generation = 1; generation <= generations; generation += 1) {
        const values: number[][] = [mean.slice()];
        while (values.length < populationSize) {
            values.push(activeIds.map((id, index) => clamp(
                mean[index] + std[index] * sampleGaussian(random),
                floorOf(id),
                AI_WEIGHT_MAX,
            )));
        }

        const evaluated: EvaluatedCandidate[] = [];
        for (const candidateValues of values) {
            const weights = fullWeights(baseline, activeIds, candidateValues);
            const train = await evaluateWeights(weights, evaluationOptions);
            evaluated.push({ weights, values: candidateValues, train });
        }
        evaluated.sort((a, b) => b.train.fitness - a.train.fitness);

        const elite = evaluated.slice(0, eliteCount);
        mean = activeIds.map((_, index) => average(elite.map((candidate) => candidate.values[index])));
        std = activeIds.map((_, index) => {
            const valuesAtIndex = elite.map((candidate) => candidate.values[index]);
            return Math.max(minStd, standardDeviation(valuesAtIndex, mean[index]));
        });

        const generationBest = evaluated[0];
        if (generationBest.train.fitness > bestTrain.fitness + 1e-9) {
            bestTrain = {
                weights: generationBest.weights,
                fitness: generationBest.train.fitness,
            };
        }
        const candidateValidation = options.validation && options.validation.length > 0
            ? await evaluateWeights(generationBest.weights, {
                ...evaluationOptions,
                scenarios: options.validation,
            })
            : null;

        if (candidateValidation) {
            if (candidateValidation.fitness > bestValidationFitness + 1e-9) {
                bestValidationFitness = candidateValidation.fitness;
                best = {
                    weights: generationBest.weights,
                    train: generationBest.train,
                    validation: candidateValidation,
                };
                validationStale = 0;
            } else {
                validationStale += 1;
            }
        } else if (generationBest.train.fitness > best.train.fitness + 1e-9) {
            best = {
                weights: generationBest.weights,
                train: generationBest.train,
                validation: null,
            };
        }

        const progress: AiOptimizerGeneration = {
            generation,
            population: populationSize,
            eliteCount,
            bestFitness: generationBest.train.fitness,
            meanFitness: average(evaluated.map((candidate) => candidate.train.fitness)),
            eliteFitness: average(elite.map((candidate) => candidate.train.fitness)),
            meanStd: average(std),
            bestWeights: generationBest.weights,
        };
        history.push(progress);
        options.onGeneration?.(progress);
        console.log(
            `[optimizer] gen ${generation}/${generations}: best ${progress.bestFitness.toFixed(4)}, `
            + `mean ${progress.meanFitness.toFixed(4)}, std ${progress.meanStd.toFixed(3)}`,
        );

        if (candidateValidation && validationStale >= validationPatience) {
            console.log(`[optimizer] validation did not improve for ${validationStale} generation(s); stopping.`);
            break;
        }
    }

    const optimized = best.weights;
    const optimizedTrain = best.train;
    const optimizedValidation = options.validation && options.validation.length > 0
        ? best.validation ?? await evaluateWeights(optimized, {
            ...evaluationOptions,
            scenarios: options.validation,
        })
        : null;
    const optimizedTest = options.test && options.test.length > 0
        ? await evaluateWeights(optimized, { ...evaluationOptions, scenarios: options.test })
        : null;
    const baselineTest = options.test && options.test.length > 0
        ? await evaluateWeights(baseline, { ...evaluationOptions, scenarios: options.test })
        : null;

    const formationCounts: Partial<Record<AiScenarioFormation, number>> = {};
    for (const scenario of options.scenarios) {
        formationCounts[scenario.formation] = (formationCounts[scenario.formation] ?? 0) + 1;
    }

    return {
        generatedAt: new Date().toISOString(),
        seed,
        difficulty,
        opponent: { id: options.opponent.id, label: options.opponent.label },
        generations,
        populationSize,
        eliteCount,
        activeConsiderationIds: activeIds,
        weightBounds: [AI_WEIGHT_MIN, AI_WEIGHT_MAX],
        weightFloors: { ...AI_WEIGHT_FLOORS },
        formationCounts,
        baselineWeights: baseline,
        optimizedWeights: optimized,
        bestTrainWeights: bestTrain.weights,
        bestTrainFitness: bestTrain.fitness,
        bestFitness: optimizedTrain.fitness,
        baseline: {
            train: baselineTrain,
            validation: baselineValidation,
            test: baselineTest,
        },
        optimized: {
            train: optimizedTrain,
            validation: optimizedValidation,
            test: optimizedTest,
        },
        history,
    };
}

function formatEvaluation(label: string, evaluation: AiWeightEvaluation | null): string {
    if (!evaluation) return `${label}: not evaluated`;
    const ci = `${(evaluation.winRateCi[0] * 100).toFixed(1)}%–${(evaluation.winRateCi[1] * 100).toFixed(1)}%`;
    return [
        `${label}: ${evaluation.battles} battles, ${evaluation.wins}W/${evaluation.losses}L/${evaluation.draws}D`,
        `win ${(evaluation.winRate * 100).toFixed(1)}% (95% CI ${ci}), max-turns ${evaluation.maxTurns}, stalemates ${evaluation.stalemates}, stalls ${evaluation.stalls}`,
        `avg turns ${evaluation.avgTurns.toFixed(1)}, pace ${evaluation.avgPace.toFixed(2)}, damage ${evaluation.avgDamage.toFixed(1)}, kills ${evaluation.avgKills.toFixed(2)}`,
        `setups ${evaluation.avgSetups.toFixed(2)}, exploits ${evaluation.avgExploits.toFixed(2)}, conversion ${(evaluation.setupConversion * 100).toFixed(0)}%, leverage ${(evaluation.statusLeverage * 100).toFixed(0)}%, follow-up ${(evaluation.setupFollowUp * 100).toFixed(0)}%`,
        `HP margin ${(evaluation.avgHpMargin * 100).toFixed(1)}%, kill margin ${(evaluation.avgKillMargin * 100).toFixed(1)}%, fitness ${evaluation.fitness.toFixed(4)}`,
    ].join('; ');
}

/** Human-readable summary for the manual optimizer runner. */
export function formatAiWeightOptimizationReport(report: AiWeightOptimizationReport): string {
    const lines: string[] = [
        'Galatime AI weight optimization',
        `generated: ${report.generatedAt}`,
        `seed: ${report.seed}`,
        `opponent: ${report.opponent.id} (${report.opponent.label})`,
        `difficulty: ${report.difficulty}`,
        `CEM: ${report.generations} generations × ${report.populationSize} population, elite ${report.eliteCount}`,
        `bounds: [${report.weightBounds[0]}, ${report.weightBounds[1]}]`,
        `floors: ${Object.entries(report.weightFloors)
            .map(([id, value]) => `${id}=${value}`)
            .join(', ') || 'none'}`,
        `active: ${report.activeConsiderationIds.join(', ')}`,
        `formations: ${Object.entries(report.formationCounts)
            .map(([id, count]) => `${id}=${count}`)
            .join(', ') || 'none'}`,
        '',
        'Weights (baseline -> optimized):',
    ];

    for (const id of AI_CONSIDERATION_IDS) {
        const frozen = report.activeConsiderationIds.includes(id) ? '' : ' (frozen)';
        lines.push(`  ${id.padEnd(18)} ${weightOf(report.baselineWeights, id).toFixed(3)} -> ${weightOf(report.optimizedWeights, id).toFixed(3)}${frozen}`);
    }

    lines.push('', 'Generation history:');
    for (const generation of report.history) {
        lines.push(
            `  gen ${generation.generation}: best ${generation.bestFitness.toFixed(4)}, `
            + `mean ${generation.meanFitness.toFixed(4)}, elite ${generation.eliteFitness.toFixed(4)}, `
            + `std ${generation.meanStd.toFixed(3)}`,
        );
    }

    lines.push('', 'Best train candidate (diagnostic; selection still uses validation):');
    lines.push(`  fitness ${report.bestTrainFitness.toFixed(4)}`);
    lines.push(`  ${AI_CONSIDERATION_IDS.map((id) => `${id}=${weightOf(report.bestTrainWeights, id).toFixed(3)}`).join(', ')}`);

    lines.push('', 'Baseline:', `  ${formatEvaluation('train', report.baseline.train)}`);
    if (report.baseline.validation) lines.push(`  ${formatEvaluation('validation', report.baseline.validation)}`);
    if (report.baseline.test) lines.push(`  ${formatEvaluation('test', report.baseline.test)}`);

    lines.push('', 'Optimized:', `  ${formatEvaluation('train', report.optimized.train)}`);
    if (report.optimized.validation) lines.push(`  ${formatEvaluation('validation', report.optimized.validation)}`);
    if (report.optimized.test) lines.push(`  ${formatEvaluation('test', report.optimized.test)}`);

    lines.push('', `selected train fitness: ${report.bestFitness.toFixed(4)}`);
    return lines.join('\n');
}
