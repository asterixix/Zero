import type { MailManager, ManagerConfig } from './types';
import { ImapMailManager, type ImapSmtpSettings } from './imap';
import { OutlookMailManager } from './microsoft';
import { GoogleMailManager } from './google';

const oauthProviders = {
  google: GoogleMailManager,
  microsoft: OutlookMailManager,
};

export const createDriver = (
  provider: keyof typeof oauthProviders | (string & {}),
  config: ManagerConfig,
): MailManager => {
  const Provider = oauthProviders[provider as keyof typeof oauthProviders];
  if (!Provider) throw new Error(`Provider not supported: ${provider}`);
  return new Provider(config);
};

export const createImapDriver = (
  config: ManagerConfig,
  settings: ImapSmtpSettings,
): MailManager => {
  return new ImapMailManager(config, settings);
};
