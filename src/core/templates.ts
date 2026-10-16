import type { App } from './app';
import { ReachloopError } from './errors';

export const TEMPLATE_VARIABLES = ['firstName', 'name', 'handle'] as const;
type Variable = (typeof TEMPLATE_VARIABLES)[number];

export type Template = { name: string; body: string };

const PLACEHOLDER = /\{\{\s*([A-Za-z]+)\s*\}\}/g;

function isVariable(value: string): value is Variable {
  return (TEMPLATE_VARIABLES as readonly string[]).includes(value);
}

export function addTemplate(app: App, template: Template): { created: boolean } {
  const unknown = [...template.body.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '').filter((v) => !isVariable(v));
  if (unknown.length > 0) {
    throw new ReachloopError('USAGE', `Unknown template variable: ${unknown.join(', ')}.`, {
      hint: `Use ${TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(', ')}.`,
    });
  }
  if (template.body.trim().length === 0) throw new ReachloopError('USAGE', 'A template needs text.');
  const existed = app.db.query('SELECT 1 FROM templates WHERE name = ?').get(template.name) !== null;
  app.db
    .query('INSERT INTO templates (name, body, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET body = excluded.body')
    .run(template.name, template.body, app.now());
  return { created: !existed };
}

export function listTemplates(app: App): Template[] {
  return app.db.query<Template, []>('SELECT name, body FROM templates ORDER BY name').all();
}

export function getTemplate(app: App, name: string): Template {
  const row = app.db.query<Template, [string]>('SELECT name, body FROM templates WHERE name = ?').get(name);
  if (!row) throw new ReachloopError('NOT_FOUND', `No template "${name}".`, { hint: 'reachloop template list' });
  return row;
}

export function removeTemplate(app: App, name: string): void {
  getTemplate(app, name);
  app.db.query('DELETE FROM templates WHERE name = ?').run(name);
}

export function renderTemplate(body: string, lead: { handle: string; name: string | null }): string {
  const name = lead.name?.trim() || lead.handle;
  const values: Record<Variable, string> = { firstName: name.split(/\s+/)[0] ?? name, name, handle: `@${lead.handle}` };
  return body.replace(PLACEHOLDER, (whole, key: string) => (isVariable(key) ? values[key] : whole));
}
