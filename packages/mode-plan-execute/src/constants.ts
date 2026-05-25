import { asPluginId } from '@moxxy/sdk';

export const PLAN_EXECUTE_MODE_NAME = 'plan-execute';

export const PLAN_PLUGIN_ID = asPluginId('@moxxy/mode-plan-execute');

export const PLAN_SYSTEM_PROMPT = `Before doing anything, produce a numbered plan of 1-6 short steps. Format strictly:

PLAN:
1. <step>
2. <step>
...

Then stop. The runtime will execute each step as a focused turn.`;

export const MAX_REDRAFTS = 5;
export const MAX_PLAN_STEPS = 12;
