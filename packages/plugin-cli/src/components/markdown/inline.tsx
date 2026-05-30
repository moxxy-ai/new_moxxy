import React from 'react';
import { Text } from 'ink';
import { tokenizeInline, type InlineTok } from '@moxxy/chat-model/markdown';

/**
 * Inline-span renderer: handles `code`, **bold**, *italic*, and [text](url)
 * within a paragraph. Tokenizes once (via @moxxy/chat-model) then maps the
 * framework-neutral token stream onto Ink <Text> nodes.
 */
export const InlineText: React.FC<{ text: string }> = ({ text }) => {
  const tokens = tokenizeInline(text);
  return (
    <Text>
      {tokens.map((t, i) => (
        <InlineToken key={i} tok={t} />
      ))}
    </Text>
  );
};

const InlineToken: React.FC<{ tok: InlineTok }> = ({ tok }) => {
  switch (tok.kind) {
    case 'text':
      return <Text>{tok.value}</Text>;
    case 'code':
      return <Text color="cyan" backgroundColor="black">{` ${tok.value} `}</Text>;
    case 'bold':
      return <Text bold>{tok.value}</Text>;
    case 'italic':
      return <Text italic>{tok.value}</Text>;
    case 'link':
      return (
        <Text>
          <Text underline color="blue">{tok.label}</Text>
          <Text dimColor>{` (${tok.url})`}</Text>
        </Text>
      );
  }
};
