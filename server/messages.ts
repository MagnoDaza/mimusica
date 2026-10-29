import { all, run } from './db.ts';

export type MessageLevel = 'info' | 'warning' | 'error';
export type MessageContext = 'library' | 'streaming' | 'alexa' | 'system';

const MAX_MESSAGES = 500;

export function addMessage(context: MessageContext, level: MessageLevel, title: string, description = '') {
  run('INSERT INTO messages (ts, context, level, title, description) VALUES (?, ?, ?, ?, ?)', Date.now(), context, level, title, description);
  run('DELETE FROM messages WHERE id <= (SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET ?)', MAX_MESSAGES);
}

export function listMessages(afterId = 0, limit = 100) {
  return all('SELECT * FROM messages WHERE id > ? ORDER BY id DESC LIMIT ?', afterId, limit);
}

export function clearMessage(id: number) {
  run('DELETE FROM messages WHERE id = ?', id);
}

export function clearAllMessages() {
  run('DELETE FROM messages');
}
