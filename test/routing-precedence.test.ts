import { describe, expect, it } from 'vitest';

import {
  evaluateRouting,
  resolvePreference,
  ROUTING_REASONS,
  type RoutingEvaluationInput,
} from '../packages/core/src/index.js';

describe('preference resolution', () => {
  it.each([
    ['defaults to enabled', 'comment.created', [], true, null],
    ['uses global', 'comment.created', [{ category: '*', enabled: false }], false, '*'],
    [
      'prefix overrides global',
      'comment.created',
      [
        { category: '*', enabled: false },
        { category: 'comment.*', enabled: true },
      ],
      true,
      'comment.*',
    ],
    [
      'exact overrides prefix',
      'comment.created',
      [
        { category: 'comment.*', enabled: true },
        { category: 'comment.created', enabled: false },
      ],
      false,
      'comment.created',
    ],
    [
      'longest prefix wins',
      'comment.reply.created',
      [
        { category: 'comment.*', enabled: false },
        { category: 'comment.reply.*', enabled: true },
      ],
      true,
      'comment.reply.*',
    ],
    [
      'prefix does not match bare event',
      'comment',
      [{ category: 'comment.*', enabled: false }],
      true,
      null,
    ],
    [
      'malformed wildcard does not overmatch',
      'comment.created',
      [{ category: 'comment*', enabled: false }],
      true,
      null,
    ],
    [
      'embedded wildcard does not overmatch',
      'comment.created',
      [{ category: 'com*ment.*', enabled: false }],
      true,
      null,
    ],
  ])('%s', (_label, event, rules, enabled, matchedCategory) => {
    expect(resolvePreference(event, rules)).toEqual({ enabled, matchedCategory });
  });
});

describe('routing precedence', () => {
  const baseline: RoutingEvaluationInput = {
    templatePresent: true,
    preferenceEnabled: true,
    critical: false,
    quietHoursActive: false,
    digestEnabled: false,
  };

  it.each([
    [
      'missing template wins',
      {
        ...baseline,
        templatePresent: false,
        preferenceEnabled: false,
        critical: true,
        quietHoursActive: true,
        digestEnabled: true,
      },
      'skip',
      ROUTING_REASONS.NO_TEMPLATE,
    ],
    [
      'disabled preference wins',
      {
        ...baseline,
        preferenceEnabled: false,
        critical: true,
        quietHoursActive: true,
        digestEnabled: true,
      },
      'skip',
      ROUTING_REASONS.PREFERENCE_DISABLED,
    ],
    [
      'critical bypasses deferral',
      { ...baseline, critical: true, quietHoursActive: true, digestEnabled: true },
      'immediate',
      ROUTING_REASONS.CRITICAL,
    ],
    [
      'quiet hours precede digest',
      { ...baseline, quietHoursActive: true, digestEnabled: true },
      'schedule',
      ROUTING_REASONS.QUIET_HOURS,
    ],
    [
      'digest follows quiet hours',
      { ...baseline, digestEnabled: true },
      'digest',
      ROUTING_REASONS.DIGEST,
    ],
    ['immediate is fallback', baseline, 'immediate', ROUTING_REASONS.IMMEDIATE],
  ])('%s', (_label, input, outcome, reason) => {
    expect(evaluateRouting(input)).toEqual({ outcome, reason });
  });
});
