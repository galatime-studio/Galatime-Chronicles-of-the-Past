/**
 * Batch evaluation on top of the headless runner.
 *
 * This is the bridge between generated scenarios and training/evaluation: one
 * call runs every policy over the same scenarios and the same per-run seeds, so
 * differences come from the policy rather than from the encounter RNG.
 */

import type { Difficulty } from '../../../../constants/DifficultyConstants';
import type {
    AiBatchPolicy,
    AiBatchPolicyStats,
    AiBatchPolicySplitStats,
    AiBatchReport,
    AiBatchRunOptions,
    AiHeadlessCombatResult,
    AiTrainingScenario,
} from '../../../../types/AiTrainingType';
import type { CombatSide } from '../../../../types/CombatType';
import { runHeadlessCombat, resetHeadlessSessions } from './headlessRunner';

function emptySplit(): AiBatchPolicySplitStats {
    return {
        battles: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        stalls: 0,
        maxTurns: 0,
        combatEnded: 0,
        winRate: 0,
    };
}

function emptyStats(policy: AiBatchPolicy): AiBatchPolicyStats {
    return {
        policyId: policy.id,
        label: policy.label,
        battles: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        stalls: 0,
        maxTurns: 0,
        combatEnded: 0,
        winRate: 0,
        avgTurns: 0,
        avgRounds: 0,
        avgDamage: 0,
        avgKills: 0,
        avgStatusesExploited: 0,
        avgBacklaneToFrontlaneSynergies: 0,
        avgProtagonistDamage: 0,
        avgProtagonistStatusBenefits: 0,
        bySplit: {
            train: emptySplit(),
            validation: emptySplit(),
            test: emptySplit(),
        },
    };
}

function protagonistSide(scenario: AiTrainingScenario): CombatSide {
    return scenario.units.find((unit) => unit.isPlayerControlled)?.side ?? 'allies';
}

function totalDamage(result: AiHeadlessCombatResult): number {
    return Object.values(result.metrics.damageByUnit).reduce((sum, value) => sum + value, 0);
}

function totalKills(result: AiHeadlessCombatResult): number {
    return Object.values(result.metrics.killsByUnit).reduce((sum, value) => sum + value, 0);
}

function accumulate(
    stats: AiBatchPolicyStats,
    scenario: AiTrainingScenario,
    result: AiHeadlessCombatResult,
): void {
    const side = protagonistSide(scenario);
    const won = result.metrics.winningSide === side;
    const lost = result.metrics.winningSide !== null && result.metrics.winningSide !== side;
    const split = stats.bySplit[scenario.split];

    stats.battles += 1;
    split.battles += 1;
    if (won) {
        stats.wins += 1;
        split.wins += 1;
    } else if (lost) {
        stats.losses += 1;
        split.losses += 1;
    } else {
        stats.draws += 1;
        split.draws += 1;
    }

    if (result.stoppedReason === 'stall') {
        stats.stalls += 1;
        split.stalls += 1;
    } else if (result.stoppedReason === 'max_turns') {
        stats.maxTurns += 1;
        split.maxTurns += 1;
    } else {
        stats.combatEnded += 1;
        split.combatEnded += 1;
    }

    // Running sums; the averages are divided out in finalizeStats.
    stats.avgTurns += result.metrics.turns;
    stats.avgRounds += result.metrics.rounds;
    stats.avgDamage += totalDamage(result);
    stats.avgKills += totalKills(result);
    stats.avgStatusesExploited += result.metrics.statusesExploited;
    stats.avgBacklaneToFrontlaneSynergies += result.metrics.backlaneToFrontlaneSynergies;
    stats.avgProtagonistDamage += result.metrics.protagonistDamage;
    stats.avgProtagonistStatusBenefits += result.metrics.protagonistStatusBenefits;
}

function finalizeStats(stats: AiBatchPolicyStats): AiBatchPolicyStats {
    const battles = Math.max(1, stats.battles);
    const finalizeSplit = (split: AiBatchPolicySplitStats): AiBatchPolicySplitStats => ({
        ...split,
        winRate: split.battles > 0 ? split.wins / split.battles : 0,
    });

    return {
        ...stats,
        winRate: stats.battles > 0 ? stats.wins / stats.battles : 0,
        avgTurns: stats.avgTurns / battles,
        avgRounds: stats.avgRounds / battles,
        avgDamage: stats.avgDamage / battles,
        avgKills: stats.avgKills / battles,
        avgStatusesExploited: stats.avgStatusesExploited / battles,
        avgBacklaneToFrontlaneSynergies: stats.avgBacklaneToFrontlaneSynergies / battles,
        avgProtagonistDamage: stats.avgProtagonistDamage / battles,
        avgProtagonistStatusBenefits: stats.avgProtagonistStatusBenefits / battles,
        bySplit: {
            train: finalizeSplit(stats.bySplit.train),
            validation: finalizeSplit(stats.bySplit.validation),
            test: finalizeSplit(stats.bySplit.test),
        },
    };
}

/**
 * Runs every policy over every scenario, `repetitions` times.
 *
 * The seed for repetition `r` is `${scenario.seed}:${r}` for all policies, so
 * paired comparisons see the same combat RNG. Repetitions still differ from
 * each other, which is what turns 100 scenarios into 1000 independent battles.
 */
export async function runAiTrainingBatch(
    options: AiBatchRunOptions,
): Promise<AiBatchReport> {
    if (options.policies.length === 0) throw new RangeError('At least one policy is required.');
    if (options.scenarios.length === 0) throw new RangeError('At least one scenario is required.');

    const repetitions = Math.max(1, Math.floor(options.repetitions ?? 1));
    const difficulty: Difficulty = options.difficulty ?? 'hard';
    const totalPerPolicy = options.scenarios.length * repetitions;
    const reports: AiBatchPolicyStats[] = [];

    for (const policy of options.policies) {
        resetHeadlessSessions();
        const stats = emptyStats(policy);
        let completed = 0;

        try {
            for (const scenario of options.scenarios) {
                for (let repetition = 0; repetition < repetitions; repetition += 1) {
                    const result = await runHeadlessCombat({
                        scenario,
                        policy: policy.policy,
                        opponentPolicy: options.opponent?.policy,
                        seed: `${scenario.seed}:${repetition}`,
                        difficulty,
                    });
                    accumulate(stats, scenario, result);
                    completed += 1;
                    options.onProgress?.({
                        policyId: policy.id,
                        scenarioId: scenario.id,
                        completed,
                        total: totalPerPolicy,
                        result,
                    });
                }
            }
        } finally {
            resetHeadlessSessions();
        }

        reports.push(finalizeStats(stats));
    }

    const splitCounts = { train: 0, validation: 0, test: 0 };
    for (const scenario of options.scenarios) splitCounts[scenario.split] += 1;

    return {
        generatedAt: new Date().toISOString(),
        scenarioCount: options.scenarios.length,
        repetitions,
        battlesPerPolicy: totalPerPolicy,
        difficulty,
        splitCounts,
        opponent: options.opponent
            ? { id: options.opponent.id, label: options.opponent.label }
            : null,
        policies: reports,
    };
}

function percent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

function fixed(value: number, digits = 1): string {
    return value.toFixed(digits);
}

function formatSplit(name: string, split: AiBatchPolicySplitStats): string {
    const stopped = split.stalls > 0 ? ` stalls ${split.stalls}` : '';
    return `    ${name.padEnd(10)} ${split.wins}/${split.battles} (${percent(split.winRate)})` +
        ` losses ${split.losses} draws ${split.draws}${stopped}`;
}

/** Human-readable report; write it to `.txt` or print it in a CI log. */
export function formatAiTrainingBatchReport(report: AiBatchReport): string {
    const lines: string[] = [
        'AI TRAINING BATCH REPORT',
        '========================',
        `generated: ${report.generatedAt}`,
        `scenarios: ${report.scenarioCount} ` +
            `(train ${report.splitCounts.train}, validation ${report.splitCounts.validation}, test ${report.splitCounts.test})`,
        `repetitions: ${report.repetitions}`,
        `battles per policy: ${report.battlesPerPolicy}`,
        `difficulty: ${report.difficulty}`,
        `opponent: ${report.opponent ? `${report.opponent.id} (${report.opponent.label})` : 'self-play (same policy both sides)'}`,
        'win = protagonist side wins (allies for generated scenarios)',
        '',
    ];

    for (const policy of report.policies) {
        lines.push(`[${policy.policyId}] ${policy.label}`);
        lines.push(
            `  battles ${policy.battles} | wins ${policy.wins} (${percent(policy.winRate)})` +
            ` | losses ${policy.losses} | draws ${policy.draws}`,
        );
        lines.push(
            `  stopped: combat_ended ${policy.combatEnded}, max_turns ${policy.maxTurns},` +
            ` stalls ${policy.stalls}`,
        );
        lines.push(
            `  avg turns ${fixed(policy.avgTurns)} | rounds ${fixed(policy.avgRounds)}` +
            ` | damage ${fixed(policy.avgDamage)} | kills ${fixed(policy.avgKills)}`,
        );
        lines.push(
            `  avg statuses exploited ${fixed(policy.avgStatusesExploited)}` +
            ` | backlane->frontlane ${fixed(policy.avgBacklaneToFrontlaneSynergies)}` +
            ` | protagonist damage ${fixed(policy.avgProtagonistDamage)}` +
            ` | protagonist status benefits ${fixed(policy.avgProtagonistStatusBenefits)}`,
        );
        lines.push('  by split:');
        lines.push(formatSplit('train', policy.bySplit.train));
        lines.push(formatSplit('validation', policy.bySplit.validation));
        lines.push(formatSplit('test', policy.bySplit.test));
        lines.push('');
    }

    return lines.join('\n');
}
