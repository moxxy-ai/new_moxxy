import { defineChannel, definePlugin, type Plugin } from '@moxxy/sdk';
import { TuiChannel } from './TuiChannel.js';

export { InteractiveSession, type InteractiveSessionProps } from './InteractiveSession.js';
export { PermissionDialog, type PermissionDialogProps } from './components/PermissionDialog.js';
export { ChatView, type ChatViewProps } from './components/ChatView.js';
export { PromptInput, type PromptInputProps } from './components/PromptInput.js';
export {
  createInteractivePermissionResolver,
  type InteractivePermissionResolverOptions,
  type PermissionPromptHandler,
} from './resolver.js';
export { TuiChannel, type TuiStartOpts } from './TuiChannel.js';
export { PermissionEditor, type PermissionEditorProps } from './components/PermissionEditor.js';
export {
  SetupWizard,
  type SetupWizardProps,
  type SetupWizardController,
  type SetupChoice,
  renderYaml,
} from './components/SetupWizard.js';

export const tuiChannelDef = defineChannel({
  name: 'tui',
  description: 'Interactive terminal UI via Ink. Default `moxxy` command.',
  create: () => new TuiChannel(),
  isAvailable: async () => {
    if (!process.stdin.isTTY) {
      return { ok: false, reason: 'stdin is not a TTY — use `moxxy -p` for headless prompts' };
    }
    return { ok: true };
  },
});

export const cliPlugin: Plugin = definePlugin({
  name: '@moxxy/plugin-cli',
  version: '0.0.0',
  channels: [tuiChannelDef],
});

export default cliPlugin;
