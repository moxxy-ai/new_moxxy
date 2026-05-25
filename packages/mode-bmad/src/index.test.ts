import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@moxxy/sdk';
import { collectTurn } from '@moxxy/core';
import { FakeProvider, createFakeSession, textReply, toolUseReply } from '@moxxy/testing';
import { BMAD_MODE_NAME, bmadModePlugin, parseStories } from './index.js';

const ANALYSIS = textReply(
  '## Problem\nWe need a version printer.\n\n## Constraints\n- read /etc/config\n\n## Success criteria\n- prints the version field',
);
const PLANNING = textReply(
  'STORIES:\n1. Read /etc/config — file contents available\n2. Print version field — version visible on stdout',
);
const SOLUTIONING = textReply(
  '## Approach\nUse the Read tool then echo the value.\n\n## Touchpoints\n- /etc/config\n\n## Risks\n- file missing',
);

describe('parseStories', () => {
  it('extracts numbered stories after a STORIES: header', () => {
    expect(parseStories('STORIES:\n1. story a\n2. story b')).toEqual(['story a', 'story b']);
  });

  it('also accepts bullets and dashes', () => {
    expect(parseStories('STORIES:\n- alpha\n* beta')).toEqual(['alpha', 'beta']);
  });

  it('returns empty array when no stories are present', () => {
    expect(parseStories('I am still thinking.')).toEqual([]);
  });

  it('tolerates parenthesized numbering "1)"', () => {
    expect(parseStories('1) one\n2) two')).toEqual(['one', 'two']);
  });
});

describe('bmad loop end-to-end', () => {
  it('walks Analysis → Planning → Solutioning → Implementation and finishes', async () => {
    const provider = new FakeProvider({
      script: [
        ANALYSIS,
        PLANNING,
        SOLUTIONING,
        // Implementation phase — one continuous tool-use loop with the
        // BMAD artifacts already in the log. First iteration calls the
        // tool; second iteration wraps up with a summary.
        toolUseReply('Read', { file_path: '/etc/config' }, 'c1'),
        textReply('Version is 1.2.3 — all stories complete'),
      ],
    });

    const session = createFakeSession({ provider });
    session.pluginHost.registerStatic(bmadModePlugin);
    session.modes.setActive(BMAD_MODE_NAME);
    session.tools.register(
      defineTool({
        name: 'Read',
        description: 'read file',
        inputSchema: z.object({ file_path: z.string() }),
        handler: () => 'version=1.2.3',
      }),
    );

    const events = await collectTurn(session, 'print the config version');

    const phaseEvents = events.filter(
      (e) => e.type === 'plugin_event' && typeof e.subtype === 'string' && e.subtype.startsWith('bmad_phase_'),
    );
    const subtypes = phaseEvents.map((e) => (e.type === 'plugin_event' ? e.subtype : ''));
    // All four phases start AND complete.
    expect(subtypes.filter((s) => s === 'bmad_phase_started')).toHaveLength(4);
    expect(subtypes.filter((s) => s === 'bmad_phase_completed')).toHaveLength(4);

    const toolResult = events.find((e) => e.type === 'tool_result');
    if (toolResult?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(toolResult.ok).toBe(true);
    expect(toolResult.output).toBe('version=1.2.3');
  });

  it('errors cleanly when planning yields no parseable stories', async () => {
    const provider = new FakeProvider({
      script: [
        ANALYSIS,
        textReply('STORIES:\n(none yet)'),
      ],
    });
    const session = createFakeSession({ provider });
    session.pluginHost.registerStatic(bmadModePlugin);
    session.modes.setActive(BMAD_MODE_NAME);

    const events = await collectTurn(session, 'do something vague');

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    if (error?.type !== 'error') throw new Error();
    expect(error.message).toMatch(/no parseable stories/i);
  });

  it('refuses absurdly long story lists', async () => {
    const tooMany = [
      'STORIES:',
      ...Array.from({ length: 15 }, (_, i) => `${i + 1}. story ${i + 1}`),
    ].join('\n');
    const provider = new FakeProvider({
      script: [ANALYSIS, textReply(tooMany)],
    });
    const session = createFakeSession({ provider });
    session.pluginHost.registerStatic(bmadModePlugin);
    session.modes.setActive(BMAD_MODE_NAME);

    const events = await collectTurn(session, 'do everything');

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    if (error?.type !== 'error') throw new Error();
    expect(error.message).toMatch(/cap is 12/);
  });
});
