import { ReachloopError } from '../../core/errors';
import { addTemplate, listTemplates, removeTemplate } from '../../core/templates';
import { bool, type Command, requiredStr } from '../command';

export const templateCommands: Command[] = [
  {
    path: 'template add',
    usage: 'reachloop template add --name intro --text "Hi {{firstName}}, ..."',
    summary: 'Save a message template. Variables: {{firstName}}, {{name}}, {{handle}}.',
    db: 'required',
    options: { name: { type: 'string' }, text: { type: 'string' } },
    run: async ({ app, values }) => {
      const template = { name: requiredStr(values, 'name'), body: requiredStr(values, 'text') };
      return { data: { ...template, ...addTemplate(app, template) } };
    },
  },
  {
    path: 'template list',
    usage: 'reachloop template list',
    summary: 'List saved templates.',
    db: 'required',
    options: {},
    run: async ({ app }) => {
      const templates = listTemplates(app);
      return { data: templates, meta: { total: templates.length, returned: templates.length } };
    },
  },
  {
    path: 'template remove',
    usage: 'reachloop template remove <name> --yes',
    summary: 'Delete a template.',
    db: 'required',
    options: { yes: { type: 'boolean' } },
    positionals: { min: 1, max: 1 },
    run: async ({ app, values, positionals }) => {
      const name = positionals[0] ?? '';
      if (!bool(values, 'yes')) throw new ReachloopError('CONFIRM_REQUIRED', `Deleting template "${name}" needs --yes.`);
      removeTemplate(app, name);
      return { data: { removed: name } };
    },
  },
];
