/**
 * Public entry for the composer's inline agent pickers. The
 * implementation is split under `agent-picker/` (container + chips +
 * the provider/model modal); this barrel keeps the historical import
 * path (`./AgentPicker`) stable for the Composer and any other
 * consumers.
 */

export { AgentPicker } from './agent-picker/AgentPicker';
