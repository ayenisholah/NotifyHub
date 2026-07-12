import Handlebars from 'handlebars';

export interface TemplateWarning<Field extends string = string> {
  field: Field;
  path: string;
}

function valueAtPath(context: Record<string, unknown>, path: string): unknown {
  let value: unknown = context;
  for (const segment of path.split('.')) {
    if (typeof value !== 'object' || value === null || !(segment in value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function templatePaths(template: string): string[] {
  const paths = [...template.matchAll(/{{{?\s*([A-Za-z_][\w.]*)\s*}?}}/g)].map(
    (match) => match[1]!,
  );
  for (const block of template.matchAll(/{{#each\s+([A-Za-z_][\w.]*)\s*}}([\s\S]*?){{\/each}}/g)) {
    const collection = block[1]!;
    const body = block[2]!;
    for (const relative of body.matchAll(/{{{?\s*([A-Za-z_][\w.]*)\s*}?}}/g)) {
      const index = paths.indexOf(relative[1]!);
      if (index !== -1) paths.splice(index, 1);
      paths.push(`${collection}.${relative[1]!}`);
    }
  }
  return paths;
}

export function renderTemplateField<Field extends string>(
  template: string,
  field: Field,
  context: Record<string, unknown>,
  escapeHtml: boolean,
  onWarning?: (warning: TemplateWarning<Field>) => void,
): string {
  if (onWarning !== undefined) {
    const paths = new Set(templatePaths(template));
    for (const path of paths) {
      const [collection, ...relative] = path.split('.');
      const collectionValue = context[collection!];
      const missing =
        relative.length > 0 && Array.isArray(collectionValue)
          ? collectionValue.some(
              (item) =>
                typeof item !== 'object' ||
                item === null ||
                valueAtPath(item as Record<string, unknown>, relative.join('.')) === undefined,
            )
          : valueAtPath(context, path) === undefined;
      if (missing) onWarning({ field, path });
    }
  }
  return Handlebars.compile(template, { noEscape: !escapeHtml })(context);
}
