import { describe, expect, it } from 'bun:test';
import { extractTextFromContent, parseTurn } from '../lib/transcripts.ts';

describe('transcript content extraction', () => {
  it('preserves Claude tool use inputs and nested tool result text', () => {
    const text = extractTextFromContent([
      {
        type: 'tool_use',
        name: 'Read',
        input: { file_path: '/tmp/example.ts', limit: 40 },
      },
      {
        type: 'tool_result',
        content: [
          { type: 'text', text: 'line 1\nline 2' },
          { type: 'image', source: { type: 'base64' } },
        ],
      },
    ]);

    expect(text).toContain('<tool: Read>');
    expect(text).toContain('"file_path": "/tmp/example.ts"');
    expect(text).toContain('<tool_result>');
    expect(text).toContain('line 1\nline 2');
    expect(text).toContain('[image]');
  });

  it('preserves Claude tool result content when content is a string', () => {
    const text = extractTextFromContent([
      {
        tool_use_id: 'toolu_123',
        type: 'tool_result',
        content: '1\\tconst value = true;\\n',
        is_error: false,
      },
    ]);

    expect(text).toBe('<tool_result>\n1\\tconst value = true;\\n');
  });

  it('maps response_item function calls into tool_call turns', () => {
    const turn = parseTurn(JSON.stringify({
      type: 'response_item',
      timestamp: '2026-05-19T10:00:00.000Z',
      payload: {
        type: 'function_call',
        name: 'Bash',
        arguments: JSON.stringify({ command: 'bun test' }),
      },
    }));

    expect(turn?.role).toBe('tool_call');
    expect(turn?.text).toContain('Bash(');
    expect(turn?.ts).toBe('2026-05-19T10:00:00.000Z');
  });
});
