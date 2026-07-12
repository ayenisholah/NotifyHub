import { defineConfig } from 'prisma/config';

const generationOnlyUrl = 'postgresql://notifyhub:notifyhub@localhost:5432/notifyhub';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? generationOnlyUrl,
  },
});
