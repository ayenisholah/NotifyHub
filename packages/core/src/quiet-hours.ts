export interface QuietHoursInput {
  now: Date;
  timezone: string;
  startMinute: number;
  endMinute: number;
}

export type QuietHoursResult =
  { active: false; scheduledFor: null } | { active: true; scheduledFor: Date };

export class InvalidQuietHoursError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidQuietHoursError';
  }
}

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function formatter(timezone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new InvalidQuietHoursError(`Invalid timezone: ${timezone}`);
  }
}

function localParts(format: Intl.DateTimeFormat, instant: Date): LocalDateTime {
  const values = Object.fromEntries(
    format
      .formatToParts(instant)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, Number(value)]),
  );
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

function addLocalDays(value: LocalDateTime, days: number): LocalDateTime {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return {
    ...value,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function localToInstant(format: Intl.DateTimeFormat, value: LocalDateTime): Date {
  const localEpoch = Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
  );
  let instantEpoch = localEpoch;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const represented = localParts(format, new Date(instantEpoch));
    const representedEpoch = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
    );
    instantEpoch -= representedEpoch - localEpoch;
  }
  return new Date(instantEpoch);
}

function validateMinute(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 1439) {
    throw new InvalidQuietHoursError(`${name} must be an integer from 0 to 1439`);
  }
}

export function resolveQuietHours(input: QuietHoursInput): QuietHoursResult {
  if (Number.isNaN(input.now.getTime())) throw new InvalidQuietHoursError('now must be valid');
  validateMinute('startMinute', input.startMinute);
  validateMinute('endMinute', input.endMinute);
  const format = formatter(input.timezone);
  if (input.startMinute === input.endMinute) return { active: false, scheduledFor: null };

  const local = localParts(format, input.now);
  const minuteOfDay = local.hour * 60 + local.minute;
  const crossesMidnight = input.startMinute > input.endMinute;
  const active = crossesMidnight
    ? minuteOfDay >= input.startMinute || minuteOfDay < input.endMinute
    : minuteOfDay >= input.startMinute && minuteOfDay < input.endMinute;
  if (!active) return { active: false, scheduledFor: null };

  const endDate =
    crossesMidnight && minuteOfDay >= input.startMinute ? addLocalDays(local, 1) : local;
  return {
    active: true,
    scheduledFor: localToInstant(format, {
      ...endDate,
      hour: Math.floor(input.endMinute / 60),
      minute: input.endMinute % 60,
      second: 0,
    }),
  };
}
