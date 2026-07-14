function attributes(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gu)].map((match) => [match[1], match[3]]),
  );
}

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'giu'))].map((match) => ({
    source: match[0],
    attributes: attributes(match[0]),
  }));
}

function required(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} must be ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}.`,
    );
  }
}

function metaContent(html, selector, value) {
  const match = tags(html, 'meta').find((tag) => tag.attributes[selector] === value);
  if (match === undefined) throw new Error(`Missing meta[${selector}=${JSON.stringify(value)}].`);
  return match.attributes.content;
}

function linkHref(html, relation) {
  const match = tags(html, 'link').find((tag) =>
    (tag.attributes.rel ?? '').split(/\s+/u).includes(relation),
  );
  if (match === undefined) throw new Error(`Missing link[rel=${JSON.stringify(relation)}].`);
  return match.attributes.href;
}

export function pngDimensions(contents) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (contents.length < 24 || !contents.subarray(0, 8).equals(signature)) {
    throw new Error('Expected a valid PNG signature.');
  }
  return { width: contents.readUInt32BE(16), height: contents.readUInt32BE(20) };
}

export function assertPublicMetadata(html, expected) {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/iu);
  required(titleMatch?.[1], expected.title, `${expected.label} title`);
  required(linkHref(html, 'canonical'), expected.canonical, `${expected.label} canonical`);
  required(
    metaContent(html, 'name', 'description'),
    expected.description,
    `${expected.label} description`,
  );
  required(metaContent(html, 'name', 'robots'), expected.robots, `${expected.label} robots`);
  required(
    metaContent(html, 'name', 'theme-color'),
    expected.themeColor,
    `${expected.label} theme color`,
  );
  required(
    metaContent(html, 'property', 'og:type'),
    'website',
    `${expected.label} Open Graph type`,
  );
  required(
    metaContent(html, 'property', 'og:site_name'),
    'NotifyHub',
    `${expected.label} Open Graph site name`,
  );
  required(
    metaContent(html, 'property', 'og:url'),
    expected.canonical,
    `${expected.label} Open Graph URL`,
  );
  required(
    metaContent(html, 'property', 'og:title'),
    expected.title,
    `${expected.label} Open Graph title`,
  );
  required(
    metaContent(html, 'property', 'og:description'),
    expected.description,
    `${expected.label} Open Graph description`,
  );
  required(
    metaContent(html, 'property', 'og:image'),
    expected.image,
    `${expected.label} Open Graph image`,
  );
  required(
    metaContent(html, 'property', 'og:image:width'),
    '1200',
    `${expected.label} Open Graph width`,
  );
  required(
    metaContent(html, 'property', 'og:image:height'),
    '630',
    `${expected.label} Open Graph height`,
  );
  required(
    metaContent(html, 'name', 'twitter:card'),
    'summary_large_image',
    `${expected.label} Twitter card`,
  );
  required(
    metaContent(html, 'name', 'twitter:title'),
    expected.title,
    `${expected.label} Twitter title`,
  );
  required(
    metaContent(html, 'name', 'twitter:description'),
    expected.description,
    `${expected.label} Twitter description`,
  );
  required(
    metaContent(html, 'name', 'twitter:image'),
    expected.image,
    `${expected.label} Twitter image`,
  );

  for (const relation of ['icon', 'apple-touch-icon', 'manifest']) linkHref(html, relation);

  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)]
    .filter((match) => attributes(match[1]).type === 'application/ld+json')
    .map((match) => JSON.parse(match[2]));
  if (scripts.length !== 1)
    throw new Error(`${expected.label} must contain exactly one JSON-LD block.`);
  required(scripts[0]['@context'], 'https://schema.org', `${expected.label} JSON-LD context`);
  required(scripts[0]['@type'], expected.structuredType, `${expected.label} JSON-LD type`);
  required(scripts[0].name, expected.structuredName, `${expected.label} JSON-LD name`);
  required(scripts[0].url, expected.canonical, `${expected.label} JSON-LD URL`);
  expected.validateStructuredData(scripts[0]);
}
