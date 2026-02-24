import {
  GmailSearchAssistantSystemPrompt,
  AiChatPrompt,
} from '../lib/prompts';
import { type Connection, type WSMessage } from 'agents';
import { EPrompts, type IOutgoingMessage, type ParsedMessage } from '../types';
import type { IGetThreadResponse, MailManager } from '../lib/driver/types';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectionToDriver } from '../lib/server-utils';
import type { CreateDraftData } from '../lib/schemas';
import { FOLDERS } from '../lib/utils';
import { env, RpcTarget } from 'cloudflare:workers';
import { AIChatAgent } from 'agents/ai-chat-agent';
import { tools as authTools } from './agent/tools';
import { processToolCalls } from './agent/utils';
import type { Message as ChatMessage } from 'ai';
import { getPromptName } from '../pipelines';
import { connection } from '../db/schema';
import { getPrompt } from '../lib/brain';
import { openai } from '@ai-sdk/openai';
import { and, eq } from 'drizzle-orm';
import { McpAgent } from 'agents/mcp';
import { createDb } from '../db';
import { z } from 'zod';

const decoder = new TextDecoder();

export enum IncomingMessageType {
  UseChatRequest = 'cf_agent_use_chat_request',
  ChatClear = 'cf_agent_chat_clear',
  ChatMessages = 'cf_agent_chat_messages',
  ChatRequestCancel = 'cf_agent_chat_request_cancel',
  Mail_List = 'zero_mail_list_threads',
  Mail_Get = 'zero_mail_get_thread',
}

export enum OutgoingMessageType {
  ChatMessages = 'cf_agent_chat_messages',
  UseChatResponse = 'cf_agent_use_chat_response',
}

// ... existing code ...

  private getDataStreamResponse(
    onFinish: StreamTextOnFinishCallback<{}>,
    _options?: {
      abortSignal: AbortSignal | undefined;
    },
  ) {
// ... existing code ...
      try {
        data = JSON.parse(message) as IncomingMessage;
      } catch {
        // silently ignore invalid messages for now
        // TODO: log errors with log levels
        return;
      }
// ... existing code ...
      let pageToken: string | null = null;
      let hasMore = true;
      let _pageCount = 0;

      while (hasMore) {
        _pageCount++;
// ... existing code ...
    cursor?: string;
  }) {
    const { labelIds = [], folder, q: _q, max = 50, cursor } = params;

    try {
// ... existing code ...
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text',
                text: 'Failed to create label',
              },
            ],
          };
        }
// ... existing code ...
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text',
                text: 'Failed to move threads to trash',
              },
            ],
          };
        }
// ... existing code ...
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text',
                text: 'Failed to archive threads',
              },
            ],
          };
        }
// ... existing code ...
