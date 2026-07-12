import { describe, expect, it } from 'vitest';

import { dependencies as apiDependencies, packageIdentity as apiPackage } from '@notifyhub/api';
import { packageIdentity as corePackage } from '@notifyhub/core';
import {
  dependencies as workerDependencies,
  packageIdentity as workersPackage,
} from '@notifyhub/workers';

describe('workspace boundaries', () => {
  it('resolves all packages through their workspace names', () => {
    expect(corePackage).toBe('@notifyhub/core');
    expect(apiPackage).toBe('@notifyhub/api');
    expect(workersPackage).toBe('@notifyhub/workers');
    expect(apiDependencies).toContain(corePackage);
    expect(workerDependencies).toContain(corePackage);
  });
});
