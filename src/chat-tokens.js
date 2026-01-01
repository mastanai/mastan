// Delivery credentials belong to one child process and one chat. They never go to disk.
import {randomBytes} from 'node:crypto';
import {config} from './config.js';

const tokens = new Map();

export function chatCredentials(chat) {
  if (!chat) return {env: {}, revoke() {}};
  const {user, channel, chatId, simulation, kind, taskId, deepseek} = chat;
  if (!['owner', 'operator'].includes(user) || !['telegram', 'web', 'whatsapp'].includes(channel) || !String(chatId || '')) throw new Error('Bad chat context');
  const token = randomBytes(32).toString('base64url');
  tokens.set(token, {user, channel, chatId: String(chatId), simulation, ...(kind ? {kind} : {}), ...(taskId ? {taskId} : {}), ...(deepseek ? {deepseek: true} : {})});
  return {env: {MASTAN_ME_RPC: `http://127.0.0.1:${config.port}`, MASTAN_ME_CHAT_TOKEN: token}, revoke() { tokens.delete(token); }};
}

export function chatForToken(token) {
  return typeof token === 'string' ? tokens.get(token) : undefined;
}
