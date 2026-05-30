/**
 * Interactive ask (permission / approval bottom sheet).
 *
 * The single `ask.respond` channel routes the renderer's reply back to
 * whichever {@link SessionDriver} raised the prompt — the broker keeps
 * the per-request mapping (see {@link answerAsk}).
 */

import { answerAsk } from '../ask-broker';
import { handle } from './shared';

export function registerAskHandlers(): void {
  // ---- Interactive ask (permission/approval bottom sheet) ------------------

  handle('ask.respond', async ({ requestId, response }) => {
    answerAsk(requestId, response);
  });
}
