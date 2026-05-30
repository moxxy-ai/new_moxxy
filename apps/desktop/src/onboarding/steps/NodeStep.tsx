/**
 * The Node.js prerequisite step — only applies when Node isn't detected.
 * Links out to nodejs.org and re-probes on demand; advances once Node is
 * present.
 */

import { useOnboarding } from '@/lib/useOnboarding';
import { StepCard, Nav, PrimaryButton, SuccessRow } from '../chrome';

/** Node.js prerequisite — only applies when Node isn't detected. */
export function NodeStep({
  onNext,
  onBack,
}: {
  readonly onNext: () => void;
  readonly onBack: () => void;
}): JSX.Element {
  const ob = useOnboarding();
  const installed = ob.node?.installed ?? false;
  return (
    <StepCard
      title="Install Node.js"
      sub="Node.js is the runtime moxxy is built on — a free download from nodejs.org. Install it, then re-check."
    >
      {installed && <SuccessRow text={`Node ${ob.node?.version ?? ''} detected`} />}
      <PrimaryButton onClick={() => void ob.openExternal('https://nodejs.org/en/download')}>
        Open nodejs.org
      </PrimaryButton>
      <Nav
        onBack={onBack}
        onNext={installed ? onNext : () => void ob.refresh()}
        nextLabel={installed ? 'Continue' : 'Re-check'}
      />
    </StepCard>
  );
}
