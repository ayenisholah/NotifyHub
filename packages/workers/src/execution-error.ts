export class ClassifiedDeliveryError extends Error {
  public readonly retryable: boolean;

  public constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'ClassifiedDeliveryError';
    this.retryable = retryable;
  }
}

export class ProviderDeliveryError extends ClassifiedDeliveryError {
  public readonly provider: string;
  public readonly status?: number;

  public constructor(
    provider: string,
    retryable: boolean,
    options: Readonly<{ status?: number; label?: string }> = {},
  ) {
    const statusText = options.status === undefined ? '' : ` (status ${options.status})`;
    super(`${options.label ?? provider} delivery failed${statusText}`, retryable);
    this.name = 'ProviderDeliveryError';
    this.provider = provider;
    if (options.status !== undefined) this.status = options.status;
  }
}

export function classifyDeliveryError(error: unknown): Readonly<{
  retryable: boolean;
  message: string;
  kind: string;
}> {
  if (error instanceof ClassifiedDeliveryError) {
    return { retryable: error.retryable, message: error.message, kind: error.name };
  }
  return { retryable: true, message: 'Unexpected delivery failure', kind: 'UnexpectedError' };
}
