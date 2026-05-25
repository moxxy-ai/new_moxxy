/**
 * Vault keys + token validation shared by the channel, its subcommands, and the
 * interactive setup wizard. Kept in their own module so the wizard / pair-flow
 * helpers can import them without pulling in the plugin's full index.
 */

/** Vault key the plugin uses for the Bot API token. */
export const TELEGRAM_TOKEN_KEY = 'telegram_bot_token';
/** Vault key the plugin uses for the paired chat id. */
export const TELEGRAM_AUTHORIZED_CHAT_KEY = 'telegram_authorized_chat_id';
/** Regex validating a Telegram bot token (`<digits>:<22+ url-safe>`). */
export const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{20,}$/;
