/**
 * Public entry for the transcript block components. The implementation is
 * split under `blocks/` (one file per block KIND); this barrel keeps the
 * historical import path (`./BlockView`) stable for Transcript and any
 * other consumers.
 */

export { BlockView } from './blocks/BlockView';
export { StreamingAssistant } from './blocks/StreamingAssistant';
