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

export function renderTemplateField<Field extends string>(
  template: string,
  field: Field,
  context: Record<string, unknown>,
  escapeHtml: boolean,
  onWarning?: (warning: TemplateWarning<Field>) => void,
): string {
  if (onWarning !== undefined) {
    const paths = new Set(
      [...template.matchAll(/{{{?\s*([A-Za-z_][\w.]*)\s*}?}}/g)].map((match) => match[1]!),
    );
    for (const path of paths) {
      if (valueAtPath(context, path) === undefined) onWarning({ field, path });
    }
  }
  return Handlebars.compile(template, { noEscape: !escapeHtml })(context);
}
