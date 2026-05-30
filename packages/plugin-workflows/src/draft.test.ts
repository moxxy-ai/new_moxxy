import { describe, expect, it } from 'vitest';
import { FakeProvider, textReply } from '@moxxy/testing';
import { buildSystemPrompt, draftWorkflow } from './draft.js';

const MULTI_STEP_DRAFT = `\`\`\`yaml
name: image-report-email
description: Collect image brief in chat, generate it, write a report, and email it.
enabled: true
inputs:
  recipient:
    default: ""
    description: Email address for the final report.
steps:
  - id: collect_brief
    label: Collect image brief
    awaitInput: true
    prompt: |
      Ask the operator what image they want generated.
  - id: generate_image
    needs: [collect_brief]
    label: Generate image
    prompt: |
      Generate the image from the brief:
      {{ steps.collect_brief.output }}
  - id: write_report
    needs: [generate_image]
    label: Write report
    prompt: |
      Write a report about the image.
      {{ steps.generate_image.output }}
  - id: send_email
    needs: [write_report]
    label: Send report
    tool: gmail_send
    args:
      to: "{{ inputs.recipient }}"
      subject: "Image workflow report"
      body: "{{ steps.write_report.output }}"
\`\`\``;

describe('draftWorkflow', () => {
  it('buildSystemPrompt lists skills and tools with descriptions', () => {
    const prompt = buildSystemPrompt({
      availableSkills: [{ name: 'web-research', description: 'Search the web' }],
      availableTools: [{ name: 'gmail_send', description: 'Send email via Gmail' }],
    });
    expect(prompt).toContain('web-research');
    expect(prompt).toContain('Search the web');
    expect(prompt).toContain('gmail_send');
    expect(prompt).toContain('at least 4 steps');
    expect(prompt).toContain('<< skill-name >>');
    expect(prompt).toContain('awaitInput: true');
    expect(prompt).toContain('collect_brief');
  });

  it('parses a multi-step drafted workflow from provider output', async () => {
    const provider = new FakeProvider({
      script: [textReply(MULTI_STEP_DRAFT)],
    });
    const drafted = await draftWorkflow(
      provider,
      'fake-model',
      'zapytaj o zdjęcie, wygeneruj, raport, wyślij maila',
      AbortSignal.timeout(5000),
      {
        availableSkills: [{ name: 'web-research', description: 'Research' }],
        availableTools: [{ name: 'gmail_send', description: 'Send mail' }],
      },
    );
    expect(drafted.parse.ok).toBe(true);
    expect(drafted.parse.errors).toEqual([]);
    expect(drafted.parse.workflow?.name).toBe('image-report-email');
    expect(drafted.parse.workflow?.steps).toHaveLength(4);
    expect(drafted.parse.workflow?.inputs?.recipient).toBeDefined();
    expect(drafted.parse.workflow?.steps[3]?.tool).toBe('gmail_send');
    expect(provider.received[0]?.maxTokens).toBe(4096);
  });
});
