import {
  DeliveryStatus,
  type Channel,
  type Delivery,
  type Prisma,
  type PrismaClient,
} from './generated/prisma/client.js';

interface DeliveryCreationBase {
  notificationId: string;
  channel: Channel;
  provider: string;
  detail?: Prisma.InputJsonValue;
}

type DeliveryCreationClient = Pick<PrismaClient, 'delivery'>;
export type DeliveryTransitionClient = Pick<Prisma.TransactionClient, 'delivery' | 'deliveryEvent'>;

export type CreateDeliveryInput = DeliveryCreationBase &
  (
    | {
        initialStatus?: typeof DeliveryStatus.QUEUED;
        scheduledFor?: never;
      }
    | {
        initialStatus: typeof DeliveryStatus.SCHEDULED;
        scheduledFor: Date;
      }
  );

export interface TransitionDeliveryInput {
  deliveryId: string;
  expectedStatus: DeliveryStatus;
  status: DeliveryStatus;
  attempts?: number;
  lastError?: string | null;
  providerMessageId?: string | null;
  detail?: Prisma.InputJsonValue;
}

export class DeliveryNotFoundError extends Error {
  public constructor(deliveryId: string) {
    super(`Delivery not found: ${deliveryId}`);
    this.name = 'DeliveryNotFoundError';
  }
}

export class DeliveryTransitionConflictError extends Error {
  public constructor(deliveryId: string, expectedStatus: DeliveryStatus) {
    super(`Delivery ${deliveryId} is no longer ${expectedStatus}`);
    this.name = 'DeliveryTransitionConflictError';
  }
}

export class InvalidDeliveryStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidDeliveryStateError';
  }
}

const allowedTransitions: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  [DeliveryStatus.QUEUED]: [DeliveryStatus.PROCESSING],
  [DeliveryStatus.SCHEDULED]: [DeliveryStatus.PROCESSING],
  [DeliveryStatus.PROCESSING]: [
    DeliveryStatus.SENT,
    DeliveryStatus.RETRYING,
    DeliveryStatus.FAILED,
  ],
  [DeliveryStatus.RETRYING]: [DeliveryStatus.PROCESSING, DeliveryStatus.FAILED],
  [DeliveryStatus.FAILED]: [DeliveryStatus.DLQ],
  [DeliveryStatus.SENT]: [],
  [DeliveryStatus.DLQ]: [],
};

function validateTransition(input: TransitionDeliveryInput): void {
  if (!allowedTransitions[input.expectedStatus].includes(input.status)) {
    throw new InvalidDeliveryStateError(
      `Invalid delivery transition: ${input.expectedStatus} -> ${input.status}`,
    );
  }
  if (input.providerMessageId !== undefined && input.status !== DeliveryStatus.SENT) {
    throw new InvalidDeliveryStateError('providerMessageId can only be set when marking sent');
  }
  if (
    input.lastError !== undefined &&
    !(
      [DeliveryStatus.RETRYING, DeliveryStatus.FAILED, DeliveryStatus.DLQ] as DeliveryStatus[]
    ).includes(input.status)
  ) {
    throw new InvalidDeliveryStateError(
      'lastError can only be set when marking retrying, failed, or dlq',
    );
  }
  if (input.attempts !== undefined && (!Number.isInteger(input.attempts) || input.attempts < 0)) {
    throw new InvalidDeliveryStateError('attempts must be a non-negative integer');
  }
}

export async function createDelivery(
  prisma: DeliveryCreationClient,
  input: CreateDeliveryInput,
): Promise<Delivery> {
  const status = input.initialStatus ?? DeliveryStatus.QUEUED;
  const scheduledFor =
    input.initialStatus === DeliveryStatus.SCHEDULED ? input.scheduledFor : undefined;

  return prisma.delivery.create({
    data: {
      notificationId: input.notificationId,
      channel: input.channel,
      provider: input.provider,
      status,
      ...(scheduledFor === undefined ? {} : { scheduledFor }),
      events: {
        create: {
          status,
          ...(input.detail === undefined ? {} : { detail: input.detail }),
        },
      },
    },
  });
}

export async function transitionDelivery(
  prisma: PrismaClient,
  input: TransitionDeliveryInput,
): Promise<Delivery> {
  validateTransition(input);

  return prisma.$transaction((transaction) => transitionDeliveryInTransaction(transaction, input));
}

export async function transitionDeliveryInTransaction(
  prisma: DeliveryTransitionClient,
  input: TransitionDeliveryInput,
): Promise<Delivery> {
  validateTransition(input);
  const current = await prisma.delivery.findUnique({ where: { id: input.deliveryId } });
  if (current === null) throw new DeliveryNotFoundError(input.deliveryId);
  if (input.attempts !== undefined && input.attempts < current.attempts) {
    throw new InvalidDeliveryStateError('attempts cannot decrease');
  }

  const updated = await prisma.delivery.updateMany({
    where: { id: input.deliveryId, status: input.expectedStatus },
    data: {
      status: input.status,
      ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
      ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
      ...(input.providerMessageId === undefined
        ? {}
        : { providerMessageId: input.providerMessageId }),
    },
  });
  if (updated.count !== 1) {
    throw new DeliveryTransitionConflictError(input.deliveryId, input.expectedStatus);
  }

  await prisma.deliveryEvent.create({
    data: {
      deliveryId: input.deliveryId,
      status: input.status,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    },
  });

  return prisma.delivery.findUniqueOrThrow({ where: { id: input.deliveryId } });
}
