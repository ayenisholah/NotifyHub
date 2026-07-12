import { packageIdentity as corePackage } from '@notifyhub/core';

export const packageIdentity = '@notifyhub/api' as const;
export const dependencies = [corePackage] as const;
