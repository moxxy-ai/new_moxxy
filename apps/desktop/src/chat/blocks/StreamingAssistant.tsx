import { AssistantBlock } from './AssistantBlock';

/** Live assistant text while chunks are still arriving — rendered by
 *  Transcript from the store's separate `streamingText`, not a block. */
export function StreamingAssistant({ text }: { readonly text: string }): JSX.Element {
  return <AssistantBlock text={text} streaming />;
}
