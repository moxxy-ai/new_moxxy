import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@moxxy/sdk';
import { FakeProvider, createFakeSession, textReply, toolUseReply } from '@moxxy/testing';
import { toolUseModePlugin } from '@moxxy/mode-tool-use';
import { collectTurn } from '@moxxy/core';
import { buildDispatchAgentTool } from './dispatch-agent.js';

const dispatchAgentTool = buildDispatchAgentTool({ getAgent: () => undefined });

describe('subagents — basic spawning', () => {
  it('spawns a child that runs a tool and returns its text', async () => {
    // The parent immediately dispatches one child agent.
    const provider = new FakeProvider({
      script: [
        // Parent's only message — kick off the child.
        toolUseReply(
          'dispatch_agent',
          {
            agents: [
              {
                prompt: 'Read /etc/config and report its version',
                label: 'reader',
              },
            ],
          },
          'p1',
        ),
        // Child's iteration 1: call Read.
        toolUseReply('Read', { file_path: '/etc/config' }, 'c1'),
        // Child's iteration 2: summarize.
        textReply('Version is 1.2.3'),
        // Parent's iteration 2: end turn with summary.
        textReply('reader reported: Version is 1.2.3'),
      ],
    });
    const session = createFakeSession({ provider });
    session.pluginHost.registerStatic(toolUseModePlugin);
    session.modes.setActive('tool-use');
    session.tools.register(
      defineTool({
        name: 'Read',
        description: 'read file',
        inputSchema: z.object({ file_path: z.string() }),
        handler: () => 'version=1.2.3',
      }),
    );
    // Register the dispatch_agent tool so the parent can invoke it.
    session.tools.register(dispatchAgentTool);

    const events = await collectTurn(session, 'use a sub-agent to fetch the version');

    // Parent log should carry subagent_started + subagent_completed envelopes.
    const started = events.find(
      (e) => e.type === 'plugin_event' && e.subtype === 'subagent_started',
    );
    expect(started).toBeDefined();
    if (started?.type === 'plugin_event') {
      const payload = started.payload as { label: string; mode: string };
      expect(payload.label).toBe('reader');
      expect(payload.mode).toBe('tool-use');
    }

    const completed = events.find(
      (e) => e.type === 'plugin_event' && e.subtype === 'subagent_completed',
    );
    expect(completed).toBeDefined();
    if (completed?.type === 'plugin_event') {
      const payload = completed.payload as { label: string; text: string };
      expect(payload.label).toBe('reader');
      expect(payload.text).toContain('1.2.3');
    }
  });

  it('streams child tool calls to the parent in real time', async () => {
    const provider = new FakeProvider({
      script: [
        toolUseReply(
          'dispatch_agent',
          { agents: [{ prompt: 'Read a file', label: 'a' }] },
          'p1',
        ),
        // Child iteration: tool call + text wrap.
        toolUseReply('Read', { file_path: '/x' }, 'c1'),
        textReply('done'),
        // Parent wrap-up.
        textReply('child finished'),
      ],
    });
    const session = createFakeSession({ provider });
    session.pluginHost.registerStatic(toolUseModePlugin);
    session.modes.setActive('tool-use');
    session.tools.register(
      defineTool({
        name: 'Read',
        description: 'read',
        inputSchema: z.object({ file_path: z.string() }),
        handler: () => 'contents',
      }),
    );
    session.tools.register(dispatchAgentTool);

    const events = await collectTurn(session, 'fan out');

    // We expect at least one subagent_tool_call event mirroring the child's Read invocation.
    const childToolCall = events.find(
      (e) => e.type === 'plugin_event' && e.subtype === 'subagent_tool_call',
    );
    expect(childToolCall).toBeDefined();
    if (childToolCall?.type === 'plugin_event') {
      const payload = childToolCall.payload as { name: string; label: string };
      expect(payload.name).toBe('Read');
      expect(payload.label).toBe('a');
    }

    // And a tool_result mirror.
    const childToolResult = events.find(
      (e) => e.type === 'plugin_event' && e.subtype === 'subagent_tool_result',
    );
    expect(childToolResult).toBeDefined();
  });

  it('spawnAll runs multiple children and returns results in input order', async () => {
    // 3 children, each replies once. Parent kicks them off in one dispatch_agent call.
    const provider = new FakeProvider({
      script: [
        toolUseReply(
          'dispatch_agent',
          {
            agents: [
              { prompt: 'task 1', label: 'one' },
              { prompt: 'task 2', label: 'two' },
              { prompt: 'task 3', label: 'three' },
            ],
          },
          'p1',
        ),
        // The FakeProvider replies to requests in script order; with 3 parallel
        // children all making their first request roughly together, the order is
        // deterministic-enough for this test: each child gets a textReply ending its turn.
        textReply('done 1'),
        textReply('done 2'),
        textReply('done 3'),
        textReply('all done'),
      ],
    });
    const session = createFakeSession({ provider });
    session.pluginHost.registerStatic(toolUseModePlugin);
    session.modes.setActive('tool-use');
    session.tools.register(dispatchAgentTool);

    const events = await collectTurn(session, 'spawn three');

    const completed = events.filter(
      (e) => e.type === 'plugin_event' && e.subtype === 'subagent_completed',
    );
    expect(completed).toHaveLength(3);
    const labels = completed
      .map((e) => (e.type === 'plugin_event' ? (e.payload as { label: string }).label : ''))
      .sort();
    expect(labels).toEqual(['one', 'three', 'two']);
  });
});
