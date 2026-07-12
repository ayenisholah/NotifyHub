export const ROUTING_REASONS = {
  NO_TEMPLATE: 'no_template',
  PREFERENCE_DISABLED: 'preference_disabled',
  CRITICAL: 'critical',
  QUIET_HOURS: 'quiet_hours',
  DIGEST: 'digest',
  IMMEDIATE: 'immediate',
} as const;

export type RoutingReason = (typeof ROUTING_REASONS)[keyof typeof ROUTING_REASONS];

export interface PreferenceRule {
  category: string;
  enabled: boolean;
}

export interface PreferenceResolution {
  enabled: boolean;
  matchedCategory: string | null;
}

export function resolvePreference(
  event: string,
  preferences: readonly PreferenceRule[],
): PreferenceResolution {
  const exact = preferences.find(({ category }) => category === event);
  if (exact !== undefined) return { enabled: exact.enabled, matchedCategory: exact.category };

  const prefix = preferences
    .filter(({ category }) => {
      if (!category.endsWith('.*') || category === '*') return false;
      const base = category.slice(0, -2);
      return base.length > 0 && event.startsWith(`${base}.`);
    })
    .sort((left, right) => right.category.length - left.category.length)[0];
  if (prefix !== undefined) return { enabled: prefix.enabled, matchedCategory: prefix.category };

  const global = preferences.find(({ category }) => category === '*');
  return global === undefined
    ? { enabled: true, matchedCategory: null }
    : { enabled: global.enabled, matchedCategory: global.category };
}

export interface RoutingEvaluationInput {
  templatePresent: boolean;
  preferenceEnabled: boolean;
  critical: boolean;
  quietHoursActive: boolean;
  digestEnabled: boolean;
}

export type RoutingDecision =
  | { outcome: 'skip'; reason: typeof ROUTING_REASONS.NO_TEMPLATE }
  | { outcome: 'skip'; reason: typeof ROUTING_REASONS.PREFERENCE_DISABLED }
  | { outcome: 'immediate'; reason: typeof ROUTING_REASONS.CRITICAL }
  | { outcome: 'schedule'; reason: typeof ROUTING_REASONS.QUIET_HOURS }
  | { outcome: 'digest'; reason: typeof ROUTING_REASONS.DIGEST }
  | { outcome: 'immediate'; reason: typeof ROUTING_REASONS.IMMEDIATE };

export function evaluateRouting(input: RoutingEvaluationInput): RoutingDecision {
  if (!input.templatePresent) return { outcome: 'skip', reason: ROUTING_REASONS.NO_TEMPLATE };
  if (!input.preferenceEnabled) {
    return { outcome: 'skip', reason: ROUTING_REASONS.PREFERENCE_DISABLED };
  }
  if (input.critical) return { outcome: 'immediate', reason: ROUTING_REASONS.CRITICAL };
  if (input.quietHoursActive) return { outcome: 'schedule', reason: ROUTING_REASONS.QUIET_HOURS };
  if (input.digestEnabled) return { outcome: 'digest', reason: ROUTING_REASONS.DIGEST };
  return { outcome: 'immediate', reason: ROUTING_REASONS.IMMEDIATE };
}
