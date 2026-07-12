import { packageIdentity as corePackage } from '@notifyhub/core';

export const packageIdentity = '@notifyhub/workers' as const;
export const dependencies = [corePackage] as const;
