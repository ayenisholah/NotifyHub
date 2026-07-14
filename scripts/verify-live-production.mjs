const origin = (process.env.PRODUCTION_URL ?? 'https://notifyhub.sholaayeni.xyz').replace(
  /\/$/u,
  '',
);

async function response(path) {
  const result = await fetch(`${origin}${path}`, { redirect: 'error' });
  if (!result.ok) throw new Error(`${path} returned HTTP ${result.status}`);
  return result;
}

function requireText(contents, expected, label) {
  if (!contents.includes(expected))
    throw new Error(`${label} is missing ${JSON.stringify(expected)}`);
}

const demo = await (await response('/')).text();
for (const expected of [
  `<link rel="canonical" href="${origin}/"`,
  `<meta property="og:url" content="${origin}/"`,
  `<meta property="og:image" content="${origin}/social-demo.png"`,
  '<link rel="manifest" href="/site.webmanifest"',
])
  requireText(demo, expected, 'demo metadata');

const dashboard = await (await response('/dashboard')).text();
for (const expected of [
  `<link rel="canonical" href="${origin}/dashboard"`,
  `<meta property="og:url" content="${origin}/dashboard"`,
  `content="${origin}/dashboard/social-dashboard.png"`,
])
  requireText(dashboard, expected, 'dashboard metadata');

for (const path of ['/social-demo.png', '/dashboard/social-dashboard.png']) {
  const bytes = Buffer.from(await (await response(path)).arrayBuffer());
  if (bytes.length < 24 || bytes.readUInt32BE(16) !== 1200 || bytes.readUInt32BE(20) !== 630) {
    throw new Error(`${path} is not a 1200x630 PNG`);
  }
}

const manifest = await (await response('/site.webmanifest')).json();
if (manifest.name !== 'NotifyHub' || manifest.start_url !== '/' || manifest.scope !== '/') {
  throw new Error('The live web manifest is invalid');
}
const robots = await (await response('/robots.txt')).text();
requireText(robots, 'Allow: /', 'robots.txt');
requireText(robots, `${origin}/sitemap.xml`, 'robots.txt');
const sitemap = await (await response('/sitemap.xml')).text();
requireText(sitemap, `<loc>${origin}/</loc>`, 'sitemap.xml');
requireText(sitemap, `<loc>${origin}/dashboard</loc>`, 'sitemap.xml');

process.stdout.write(`Verified live public metadata at ${origin}\n`);
