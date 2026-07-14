import { Channel, type PrismaClient } from '@notifyhub/core';

export const DEMO_EVENT = 'project.updated';

const templates = [
  {
    channel: Channel.EMAIL,
    subject: 'Project update: {{payload.projectName}}',
    body: '{{payload.actor}} {{payload.summary}} in {{payload.projectName}}.',
    bodyHtml:
      '<p><strong>{{payload.actor}}</strong> {{payload.summary}} in {{payload.projectName}}.</p>',
  },
  {
    channel: Channel.SMS,
    subject: null,
    body: '{{payload.actor}} {{payload.summary}} in {{payload.projectName}}.',
    bodyHtml: null,
  },
  {
    channel: Channel.IN_APP,
    subject: 'Project update',
    body: '{{payload.actor}} {{payload.summary}} in {{payload.projectName}}.',
    bodyHtml: null,
  },
] as const;

export async function seedDemoFixtures(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.user.upsert({
    where: { id: userId },
    create: {
      id: userId,
      email: 'alex.morgan@example.test',
      phone: '+2348000000000',
      timezone: 'Africa/Lagos',
    },
    update: {
      email: 'alex.morgan@example.test',
      phone: '+2348000000000',
      timezone: 'Africa/Lagos',
    },
  });

  for (const template of templates) {
    const data = {
      subject: template.subject,
      body: template.body,
      bodyHtml: template.bodyHtml,
      digestBody: null,
      digestEnabled: false,
      digestWindowMinutes: 10,
    };
    await prisma.template.upsert({
      where: {
        event_channel_locale: { event: DEMO_EVENT, channel: template.channel, locale: 'en' },
      },
      create: { event: DEMO_EVENT, channel: template.channel, locale: 'en', ...data },
      update: data,
    });
  }
}
