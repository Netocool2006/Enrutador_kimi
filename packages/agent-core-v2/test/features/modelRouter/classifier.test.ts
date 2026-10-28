import { describe, expect, it } from 'vitest';

import { classifyTask, nextTier } from '#/features/modelRouter/classifier';

describe('classifyTask', () => {
  it('classifies mechanical lookups as T0', () => {
    const result = classifyTask('Find the file where the router config is loaded');
    expect(result.tier).toBe('T0');
    expect(result.uncertain).toBe(false);
  });

  it('classifies renames and typos as T0', () => {
    expect(classifyTask('Rename userServce to userService').tier).toBe('T0');
    expect(classifyTask('Fix the typo in the login label').tier).toBe('T0');
  });

  it('classifies short chat without signals as T0 and marks it uncertain', () => {
    const result = classifyTask('hola, qué tal');
    expect(result.tier).toBe('T0');
    expect(result.uncertain).toBe(true);
  });

  it('classifies bounded fixes and small tests as T1', () => {
    expect(classifyTask('Fix the off-by-one error in paginate() and add a unit test').tier).toBe(
      'T1',
    );
    expect(classifyTask('Update the changelog for the last release').tier).toBe('T1');
  });

  it('classifies concurrency and performance work as T2', () => {
    expect(classifyTask('Debug the race condition in the connection pool').tier).toBe('T2');
    expect(classifyTask('Optimize the rendering latency of the dashboard').tier).toBe('T2');
    expect(classifyTask('Refactor the logging module to use the new interface').tier).toBe('T2');
  });

  it('classifies architecture and persistent failures as T3', () => {
    expect(classifyTask('Redesign the persistence architecture for multi-tenant support').tier).toBe(
      'T3',
    );
    expect(
      classifyTask('The build keeps failing on CI and we have no idea why, investigate').tier,
    ).toBe('T3');
  });

  it('rounds ambiguous long prompts up conservatively', () => {
    const result = classifyTask(
      'I need you to take a look at something in the repository when you have a moment',
    );
    expect(result.uncertain).toBe(true);
    expect(['T1', 'T2']).toContain(result.tier);
    expect(result.tier).not.toBe('T0');
  });

  it('does not round up when roundUpWhenUncertain is false', () => {
    const result = classifyTask(
      'I need you to take a look at something in the repository when you have a moment',
      { roundUpWhenUncertain: false },
    );
    expect(result.tier).toBe('T1');
  });

  it('raises tasks touching risky areas to at least T2', () => {
    const result = classifyTask('Update the authentication token refresh logic');
    expect(result.tier).toBe('T2');
    expect(result.reasons.some((reason) => reason.startsWith('risk:'))).toBe(true);
  });

  it('keeps higher tier when risk and critical signals combine', () => {
    const result = classifyTask('Redesign the security architecture of the auth module');
    expect(result.tier).toBe('T3');
  });

  it('raises multi-step requests by one tier', () => {
    const result = classifyTask(
      'Fix the login bug and then update the docs and also add a regression test for it',
    );
    expect(result.tier).toBe('T2');
    expect(result.reasons).toContain('multi-step');
  });

  it('supports Spanish task descriptions', () => {
    expect(classifyTask('Busca dónde se lee la configuración').tier).toBe('T0');
    expect(classifyTask('Corrige el error de concurrencia en el módulo de red').tier).toBe('T2');
    expect(classifyTask('Rediseña la arquitectura del sistema de persistencia').tier).toBe('T3');
  });

  it('caps multi-step escalation at T3', () => {
    expect(classifyTask('Redesign the architecture and then migrate the database').tier).toBe('T3');
  });
});

describe('nextTier', () => {
  it('walks tiers in order and stops at T3', () => {
    expect(nextTier('T0')).toBe('T1');
    expect(nextTier('T1')).toBe('T2');
    expect(nextTier('T2')).toBe('T3');
    expect(nextTier('T3')).toBeUndefined();
  });
});
