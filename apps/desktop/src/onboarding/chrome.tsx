/**
 * Shared onboarding chrome — the public surface every step and the flow
 * orchestrator import from. The implementation now lives in focused
 * leaf modules under ./chrome/ (the wizard Shell, the step primitives,
 * the branded Clerk appearance, and the style tokens); this barrel keeps
 * the single `./chrome` import path stable for consumers.
 */

export { CLERK_KEY, brandedClerkAppearance } from './chrome/clerk-appearance';
export { Shell } from './chrome/Shell';
export { StepCard, Nav, PrimaryButton, SuccessRow, Pulse } from './chrome/primitives';
export {
  inputStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
  pickerBtnStyle,
  authCardStyle,
} from './chrome/styles';
