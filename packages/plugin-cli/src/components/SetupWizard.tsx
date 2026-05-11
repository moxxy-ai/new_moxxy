import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';

export interface SetupChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** When true, the option is rendered but cannot be selected (with the disabled reason). */
  readonly disabled?: string;
}

export interface SetupWizardController {
  /** Persist an API key to the vault. Called once per selected provider. */
  saveApiKey(providerId: string, key: string): Promise<void>;
  /** Persist the rendered yaml config. The wizard generates the body; the controller decides where. */
  writeConfig(yaml: string): Promise<string>;
  /** Optional connectivity check the wizard runs after key entry. Returns ok or error message. */
  testKey?(providerId: string, key: string): Promise<{ ok: true } | { ok: false; message: string }>;
}

export interface SetupWizardProps {
  readonly providers: ReadonlyArray<SetupChoice>;
  readonly models: Record<string, ReadonlyArray<SetupChoice>>;
  readonly loops: ReadonlyArray<SetupChoice>;
  readonly embedders: ReadonlyArray<SetupChoice>;
  readonly controller: SetupWizardController;
  readonly onComplete?: (path: string) => void;
}

type Step =
  | { kind: 'welcome' }
  | { kind: 'providers'; selected: Set<string>; cursor: number }
  | { kind: 'apikey'; queue: string[]; index: number; buffer: string; testing: boolean; testError: string | null }
  | { kind: 'primary'; choices: ReadonlyArray<string>; cursor: number }
  | { kind: 'model'; provider: string; cursor: number }
  | { kind: 'loop'; cursor: number }
  | { kind: 'embedder'; cursor: number }
  | { kind: 'review'; saving: boolean }
  | { kind: 'done'; path: string };

interface Selections {
  readonly providers: ReadonlyArray<string>;
  readonly apiKeys: Record<string, string>;
  readonly primary: string;
  readonly model: string | null;
  readonly loop: string;
  readonly embedder: string;
}

export const SetupWizard: React.FC<SetupWizardProps> = ({
  providers,
  models,
  loops,
  embedders,
  controller,
  onComplete,
}) => {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>({ kind: 'welcome' });
  const [sel, setSel] = useState<Selections>({
    providers: [],
    apiKeys: {},
    primary: '',
    model: null,
    loop: loops[0]?.id ?? 'tool-use',
    embedder: embedders[0]?.id ?? 'tfidf',
  });

  useInput((input, key) => {
    if (step.kind === 'welcome') {
      if (key.return) setStep({ kind: 'providers', selected: new Set(), cursor: 0 });
      else if (input === 'q' || key.escape) exit();
      return;
    }

    if (step.kind === 'providers') {
      if (key.upArrow) setStep({ ...step, cursor: Math.max(0, step.cursor - 1) });
      else if (key.downArrow) setStep({ ...step, cursor: Math.min(providers.length - 1, step.cursor + 1) });
      else if (input === ' ') {
        const choice = providers[step.cursor];
        if (choice && !choice.disabled) {
          const next = new Set(step.selected);
          if (next.has(choice.id)) next.delete(choice.id);
          else next.add(choice.id);
          setStep({ ...step, selected: next });
        }
      } else if (key.return) {
        const chosen = [...step.selected];
        if (chosen.length === 0) return;
        setSel({ ...sel, providers: chosen });
        setStep({
          kind: 'apikey',
          queue: chosen,
          index: 0,
          buffer: '',
          testing: false,
          testError: null,
        });
      } else if (input === 'q' || key.escape) exit();
      return;
    }

    if (step.kind === 'apikey') {
      if (step.testing) return;
      if (key.return) {
        const key2 = step.buffer.trim();
        if (!key2) return;
        const provider = step.queue[step.index]!;
        // Optionally test the key
        const proceed = (): void => {
          const nextKeys = { ...sel.apiKeys, [provider]: key2 };
          setSel({ ...sel, apiKeys: nextKeys });
          const nextIndex = step.index + 1;
          if (nextIndex >= step.queue.length) {
            // All keys collected; pick primary (first one chosen by default)
            if (step.queue.length === 1) {
              const primary = step.queue[0]!;
              setSel((s) => ({ ...s, apiKeys: nextKeys, primary }));
              setStep({ kind: 'model', provider: primary, cursor: 0 });
            } else {
              setStep({ kind: 'primary', choices: step.queue, cursor: 0 });
            }
            return;
          }
          setStep({
            kind: 'apikey',
            queue: step.queue,
            index: nextIndex,
            buffer: '',
            testing: false,
            testError: null,
          });
        };

        if (controller.testKey) {
          setStep({ ...step, testing: true, testError: null });
          void controller
            .testKey(provider, key2)
            .then((res) => {
              if (res.ok) proceed();
              else setStep({ ...step, testing: false, testError: res.message });
            })
            .catch((err) =>
              setStep({
                ...step,
                testing: false,
                testError: err instanceof Error ? err.message : String(err),
              }),
            );
        } else {
          proceed();
        }
        return;
      }
      if (key.backspace || key.delete) {
        setStep({ ...step, buffer: step.buffer.slice(0, -1) });
        return;
      }
      if (key.escape) {
        // skip this provider
        const remaining = step.queue.filter((_, i) => i !== step.index);
        if (remaining.length === 0) {
          // Nothing chosen at all — back to providers step
          setStep({ kind: 'providers', selected: new Set(sel.providers), cursor: 0 });
        } else {
          setSel({ ...sel, providers: remaining });
          setStep({
            kind: 'apikey',
            queue: remaining,
            index: Math.min(step.index, remaining.length - 1),
            buffer: '',
            testing: false,
            testError: null,
          });
        }
        return;
      }
      if (!key.ctrl && !key.meta && input && input.length === 1) {
        setStep({ ...step, buffer: step.buffer + input, testError: null });
      }
      return;
    }

    if (step.kind === 'primary') {
      if (key.upArrow) setStep({ ...step, cursor: Math.max(0, step.cursor - 1) });
      else if (key.downArrow)
        setStep({ ...step, cursor: Math.min(step.choices.length - 1, step.cursor + 1) });
      else if (key.return) {
        const primary = step.choices[step.cursor]!;
        setSel({ ...sel, primary });
        setStep({ kind: 'model', provider: primary, cursor: 0 });
      }
      return;
    }

    if (step.kind === 'model') {
      const choices = models[step.provider] ?? [];
      if (key.upArrow) setStep({ ...step, cursor: Math.max(0, step.cursor - 1) });
      else if (key.downArrow) setStep({ ...step, cursor: Math.min(choices.length - 1, step.cursor + 1) });
      else if (key.return) {
        setSel({ ...sel, model: choices[step.cursor]?.id ?? null });
        setStep({ kind: 'loop', cursor: 0 });
      }
      return;
    }

    if (step.kind === 'loop') {
      if (key.upArrow) setStep({ cursor: Math.max(0, step.cursor - 1), kind: 'loop' });
      else if (key.downArrow) setStep({ cursor: Math.min(loops.length - 1, step.cursor + 1), kind: 'loop' });
      else if (key.return) {
        setSel({ ...sel, loop: loops[step.cursor]?.id ?? sel.loop });
        setStep({ kind: 'embedder', cursor: 0 });
      }
      return;
    }

    if (step.kind === 'embedder') {
      if (key.upArrow) setStep({ cursor: Math.max(0, step.cursor - 1), kind: 'embedder' });
      else if (key.downArrow)
        setStep({ cursor: Math.min(embedders.length - 1, step.cursor + 1), kind: 'embedder' });
      else if (key.return) {
        setSel({ ...sel, embedder: embedders[step.cursor]?.id ?? sel.embedder });
        setStep({ kind: 'review', saving: false });
      }
      return;
    }

    if (step.kind === 'review') {
      if (step.saving) return;
      if (input === 'b') {
        setStep({ kind: 'embedder', cursor: 0 });
        return;
      }
      if (key.return) {
        setStep({ kind: 'review', saving: true });
        void (async () => {
          // Persist keys
          for (const provider of sel.providers) {
            const key2 = sel.apiKeys[provider];
            if (key2) await controller.saveApiKey(provider, key2);
          }
          // Render + persist yaml
          const yaml = renderYaml(sel);
          const path = await controller.writeConfig(yaml);
          setStep({ kind: 'done', path });
          onComplete?.(path);
        })();
        return;
      }
      return;
    }

    if (step.kind === 'done') {
      if (key.return || input === 'q' || key.escape) exit();
    }
  });

  useEffect(() => {
    if (step.kind === 'done') {
      const t = setTimeout(() => exit(), 1500);
      return () => clearTimeout(t);
    }
    return;
  }, [step.kind, exit]);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="magenta">moxxy</Text>
        <Text dimColor>  — interactive setup</Text>
      </Box>

      {step.kind === 'welcome' ? (
        <WelcomeStep />
      ) : step.kind === 'providers' ? (
        <ProvidersStep step={step} providers={providers} />
      ) : step.kind === 'apikey' ? (
        <ApiKeyStep step={step} />
      ) : step.kind === 'primary' ? (
        <PrimaryStep step={step} />
      ) : step.kind === 'model' ? (
        <ModelStep step={step} models={models[step.provider] ?? []} />
      ) : step.kind === 'loop' ? (
        <ChoiceStep title="Loop strategy" choices={loops} cursor={step.cursor} />
      ) : step.kind === 'embedder' ? (
        <ChoiceStep title="Memory embedder" choices={embedders} cursor={step.cursor} />
      ) : step.kind === 'review' ? (
        <ReviewStep selections={sel} saving={step.saving} />
      ) : (
        <DoneStep path={step.path} />
      )}
    </Box>
  );
};

const WelcomeStep: React.FC = () => (
  <Box flexDirection="column">
    <Text>This wizard will help you configure moxxy:</Text>
    <Text dimColor>  · pick LLM providers + store their API keys in the encrypted vault</Text>
    <Text dimColor>  · choose your default model, loop strategy, and memory embedder</Text>
    <Text dimColor>  · write a moxxy.config.yaml to your project</Text>
    <Box marginTop={1}>
      <Text color="cyan">press enter to begin</Text>
      <Text dimColor>  (q to quit)</Text>
    </Box>
  </Box>
);

const ProvidersStep: React.FC<{ step: Step & { kind: 'providers' }; providers: ReadonlyArray<SetupChoice> }> = ({
  step,
  providers,
}) => (
  <Box flexDirection="column">
    <Text bold>Step 1: Choose LLM providers</Text>
    <Text dimColor>  space to toggle · enter to continue · esc to quit</Text>
    <Box marginTop={1} flexDirection="column">
      {providers.map((p, i) => {
        const focused = i === step.cursor;
        const checked = step.selected.has(p.id);
        return (
          <Box key={p.id}>
            <Text color={focused ? 'cyan' : undefined}>{focused ? '› ' : '  '}</Text>
            <Text>{checked ? '☑' : '☐'} </Text>
            <Text>{p.label}</Text>
            {p.description ? <Text dimColor>  — {p.description}</Text> : null}
            {p.disabled ? <Text color="red"> ({p.disabled})</Text> : null}
          </Box>
        );
      })}
    </Box>
  </Box>
);

const ApiKeyStep: React.FC<{ step: Step & { kind: 'apikey' } }> = ({ step }) => {
  const provider = step.queue[step.index]!;
  const masked = '*'.repeat(step.buffer.length);
  return (
    <Box flexDirection="column">
      <Text bold>Step 2: API key for {provider}</Text>
      <Text dimColor>  paste your {provider} key · enter to confirm · esc to skip this provider</Text>
      <Box marginTop={1}>
        <Text color="cyan">› </Text>
        <Text>{masked}</Text>
        {step.testing ? <Text dimColor>  (validating…)</Text> : null}
      </Box>
      {step.testError ? (
        <Text color="red">{step.testError}</Text>
      ) : null}
    </Box>
  );
};

const PrimaryStep: React.FC<{ step: Step & { kind: 'primary' } }> = ({ step }) => (
  <Box flexDirection="column">
    <Text bold>Step 3: Pick the primary provider</Text>
    <Text dimColor>  others will be set as fallbacks</Text>
    <Box marginTop={1} flexDirection="column">
      {step.choices.map((c, i) => (
        <Text key={c} color={i === step.cursor ? 'cyan' : undefined}>
          {i === step.cursor ? '› ' : '  '}
          {c}
        </Text>
      ))}
    </Box>
  </Box>
);

const ModelStep: React.FC<{ step: Step & { kind: 'model' }; models: ReadonlyArray<SetupChoice> }> = ({ step, models }) => (
  <Box flexDirection="column">
    <Text bold>Step 4: Default model for {step.provider}</Text>
    <Box marginTop={1} flexDirection="column">
      {models.map((m, i) => (
        <Box key={m.id}>
          <Text color={i === step.cursor ? 'cyan' : undefined}>
            {i === step.cursor ? '› ' : '  '}
            {m.label}
          </Text>
          {m.description ? <Text dimColor>  — {m.description}</Text> : null}
        </Box>
      ))}
    </Box>
  </Box>
);

const ChoiceStep: React.FC<{
  title: string;
  choices: ReadonlyArray<SetupChoice>;
  cursor: number;
}> = ({ title, choices, cursor }) => (
  <Box flexDirection="column">
    <Text bold>{title}</Text>
    <Box marginTop={1} flexDirection="column">
      {choices.map((c, i) => (
        <Box key={c.id}>
          <Text color={i === cursor ? 'cyan' : undefined}>
            {i === cursor ? '› ' : '  '}
            {c.label}
          </Text>
          {c.description ? <Text dimColor>  — {c.description}</Text> : null}
        </Box>
      ))}
    </Box>
  </Box>
);

const ReviewStep: React.FC<{ selections: Selections; saving: boolean }> = ({ selections, saving }) => (
  <Box flexDirection="column">
    <Text bold>Step 6: Review</Text>
    <Box marginTop={1} flexDirection="column">
      <Text>providers: <Text color="cyan">{selections.providers.join(', ')}</Text></Text>
      <Text>primary:   <Text color="cyan">{selections.primary}</Text></Text>
      <Text>model:     <Text color="cyan">{selections.model ?? '(default)'}</Text></Text>
      <Text>loop:      <Text color="cyan">{selections.loop}</Text></Text>
      <Text>embedder:  <Text color="cyan">{selections.embedder}</Text></Text>
    </Box>
    <Box marginTop={1}>
      {saving ? (
        <Text color="yellow">writing config + vault entries…</Text>
      ) : (
        <Text dimColor>enter to save · b to go back</Text>
      )}
    </Box>
  </Box>
);

const DoneStep: React.FC<{ path: string }> = ({ path }) => (
  <Box flexDirection="column">
    <Text color="green" bold>✓ Setup complete</Text>
    <Text dimColor>  wrote {path}</Text>
    <Box marginTop={1}>
      <Text>try `moxxy -p "hello"` to verify.</Text>
    </Box>
  </Box>
);

export function renderYaml(sel: Selections): string {
  const fallbacks = sel.providers.filter((p) => p !== sel.primary);
  const lines: string[] = ['# moxxy.config.yaml — generated by `moxxy init`', ''];
  lines.push('provider:');
  lines.push(`  name: ${sel.primary}`);
  if (sel.model) lines.push(`  model: ${sel.model}`);
  // Provider config references the canonical vault entries so the key isn't checked in.
  lines.push('  config:');
  lines.push(`    apiKey: \${vault:${sel.primary.toUpperCase()}_API_KEY}`);
  if (fallbacks.length > 0) {
    lines.push('  fallbacks:');
    for (const f of fallbacks) lines.push(`    - ${f}`);
  }
  lines.push('');
  lines.push(`loop: ${sel.loop}`);
  if (sel.embedder !== 'tfidf') {
    lines.push('embeddings:');
    lines.push(`  provider: ${sel.embedder}`);
  }
  lines.push('');
  return lines.join('\n');
}
