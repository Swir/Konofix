export type NickColor = {
  value: string;
  label: string;
};

export const DEFAULT_NICK_COLOR = '#8FA0FF';

export const NICK_COLORS: readonly NickColor[] = [
  { value: '#8FA0FF', label: 'Periwinkle' },
  { value: '#62E5FF', label: 'Electric cyan' },
  { value: '#44E6A8', label: 'Mint' },
  { value: '#FFD166', label: 'Gold' },
  { value: '#FF8FAB', label: 'Rose' },
  { value: '#C77DFF', label: 'Violet' },
  { value: '#FF9F68', label: 'Orange' },
  { value: '#7AE582', label: 'Lime' },
  { value: '#5CC8FF', label: 'Sky' },
  { value: '#B8C0FF', label: 'Lavender' },
  { value: '#F4A261', label: 'Amber' },
  { value: '#E879F9', label: 'Magenta' },
] as const;

const NICK_COLOR_SET = new Set(NICK_COLORS.map(item => item.value));

export function normalizeNickColor(value?: string | null): string {
  const candidate = String(value ?? '').trim().toUpperCase();
  return NICK_COLOR_SET.has(candidate) ? candidate : DEFAULT_NICK_COLOR;
}

export type KonofixEmoji = {
  code: string;
  glyph: string;
  label: string;
};

export const KONOFIX_EMOJI: readonly KonofixEmoji[] = [
  { code: ':)', glyph: '🙂', label: 'smile' },
  { code: ':-)', glyph: '🙂', label: 'smile' },
  { code: ':D', glyph: '😄', label: 'grin' },
  { code: ':-D', glyph: '😄', label: 'grin' },
  { code: 'XD', glyph: '😂', label: 'laugh' },
  { code: 'xD', glyph: '😂', label: 'laugh' },
  { code: ';)', glyph: '😉', label: 'wink' },
  { code: ';-)', glyph: '😉', label: 'wink' },
  { code: ':*', glyph: '😘', label: 'kiss' },
  { code: ':-*', glyph: '😘', label: 'kiss' },
  { code: ':P', glyph: '😛', label: 'tongue' },
  { code: ':-P', glyph: '😛', label: 'tongue' },
  { code: ':p', glyph: '😛', label: 'tongue' },
  { code: ':(', glyph: '🙁', label: 'sad' },
  { code: ':-(', glyph: '🙁', label: 'sad' },
  { code: ":'(", glyph: '😢', label: 'cry' },
  { code: ':O', glyph: '😮', label: 'surprised' },
  { code: ':-O', glyph: '😮', label: 'surprised' },
  { code: ':|', glyph: '😐', label: 'neutral' },
  { code: ':/', glyph: '😕', label: 'confused' },
  { code: 'B)', glyph: '😎', label: 'cool' },
  { code: 'O:)', glyph: '😇', label: 'angel' },
  { code: '>:)', glyph: '😈', label: 'devil' },
  { code: '^_^', glyph: '😊', label: 'happy' },
  { code: '-_-', glyph: '😑', label: 'unamused' },
  { code: '<3', glyph: '❤️', label: 'heart' },
  { code: ':heart:', glyph: '❤️', label: 'heart' },
  { code: ':fire:', glyph: '🔥', label: 'fire' },
  { code: ':thumbsup:', glyph: '👍', label: 'thumbs up' },
  { code: ':party:', glyph: '🎉', label: 'party' },
  { code: ':wave:', glyph: '👋', label: 'wave' },
  { code: ':clap:', glyph: '👏', label: 'clap' },
  { code: ':rocket:', glyph: '🚀', label: 'rocket' },
  { code: ':robot:', glyph: '🤖', label: 'robot' },
  { code: ':eyes:', glyph: '👀', label: 'eyes' },
  { code: ':100:', glyph: '💯', label: 'hundred' },
  { code: ':ok:', glyph: '👌', label: 'ok' },
  { code: ':love:', glyph: '🥰', label: 'love' },
  { code: ':thinking:', glyph: '🤔', label: 'thinking' },
  { code: ':facepalm:', glyph: '🤦', label: 'facepalm' },
] as const;

const EMOJI_BY_CODE = new Map(KONOFIX_EMOJI.map(item => [item.code, item]));

export function escapeChatHtml(value: string): string {
  return value.replace(/[&<>'"]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
  }[ch]!));
}

function tokenEmoji(token: string): { emoji?: KonofixEmoji; suffix: string } {
  const direct = EMOJI_BY_CODE.get(token);
  if (direct) return { emoji: direct, suffix: '' };

  const match = token.match(/^(.*?)([!?,.]+)$/);
  if (!match) return { suffix: '' };
  const emoji = EMOJI_BY_CODE.get(match[1]);
  return emoji ? { emoji, suffix: match[2] } : { suffix: '' };
}

export function renderChatText(text: string): string {
  return text.split(/(\s+)/).map(part => {
    if (!part || /^\s+$/.test(part)) return escapeChatHtml(part);
    // Only whole whitespace-delimited tokens are converted. This deliberately
    // leaves URLs and code-like fragments such as https://host/:D untouched.
    const { emoji, suffix } = tokenEmoji(part);
    if (!emoji) return escapeChatHtml(part);
    return `<span class="kfx-emoji" title="${escapeChatHtml(emoji.code)}" aria-label="${escapeChatHtml(emoji.label)}">${emoji.glyph}</span>${escapeChatHtml(suffix)}`;
  }).join('');
}
