import { DEFAULT_SETTINGS } from '@/core/defaults';
import type { AutomationSnapshot } from '@/messaging/protocol';
import {
  COMMAND_TYPES,
  createRuntimeMessageListener,
  isCommand,
  type Command,
  type CommandResponse,
} from '@/messaging/protocol';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

const validCommands = [
  { type: 'get-snapshot' },
  { type: 'get-tab-list' },
  {
    type: 'start-rotation',
    targetKeys: ['tab:1', 'tab:2'],
    intervalMs: 10_000,
    direction: 'forward',
    replaceExisting: false,
  },
  { type: 'pause-rotation' },
  { type: 'resume-rotation' },
  { type: 'stop-rotation' },
  {
    type: 'start-refresh',
    targetKeys: ['tab:1'],
    intervalMs: 30_000,
    replaceExisting: true,
  },
  { type: 'stop-refresh' },
  { type: 'refresh-now', targetKeys: ['tab:1'] },
  { type: 'update-settings', settings: DEFAULT_SETTINGS },
] satisfies readonly Command[];

function snapshot(): AutomationSnapshot {
  return {
    status: 'idle',
    settings: DEFAULT_SETTINGS,
    rotation: null,
    refresh: null,
    capabilities: {
      currentWindowTabQuery: 'available',
      allWindowTabQuery: 'available',
      tabActivation: 'available',
      tabReload: 'available',
      toolbarState: 'available',
      optionsPage: 'available',
    },
  };
}

describe('messaging protocol', () => {
  it('recognizes every declared command shape', () => {
    expect(validCommands.map((command) => command.type)).toEqual(COMMAND_TYPES);

    for (const command of validCommands) {
      expect(isCommand(command), command.type).toBe(true);
    }
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a missing discriminator', { targetKeys: [] }],
    ['an unknown discriminator', { type: 'delete-everything' }],
    ['an extra property', { type: 'get-snapshot', unexpected: true }],
    [
      'a malformed rotation',
      {
        type: 'start-rotation',
        targetKeys: [1, 2],
        intervalMs: 'fast',
        direction: 'sideways',
        replaceExisting: 'yes',
      },
    ],
    ['an incomplete refresh', { type: 'start-refresh', targetKeys: ['tab:1'], intervalMs: 30_000 }],
    ['an invalid target list', { type: 'refresh-now', targetKeys: 'tab:1' }],
    ['a partial settings update', { type: 'update-settings', settings: { includePinned: true } }],
    [
      'an invalid settings field',
      { type: 'update-settings', settings: { ...DEFAULT_SETTINGS, includePinned: 'yes' } },
    ],
  ])('rejects %s', (_description, value) => {
    expect(isCommand(value)).toBe(false);
  });

  it('delivers valid commands through sendResponse without returning a promise', async () => {
    const response: CommandResponse = {
      ok: true,
      command: 'get-snapshot',
      data: snapshot(),
    };
    const handler = vi.fn().mockResolvedValue(response);
    const sendResponse = vi.fn();
    const listener = createRuntimeMessageListener(handler);

    const returnValue = listener({ type: 'get-snapshot' }, { id: 'extension-id' }, sendResponse);

    expect(returnValue).toBe(true);
    expect(returnValue).not.toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(response));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ type: 'get-snapshot' }, { id: 'extension-id' });
  });

  it('rejects malformed messages before dispatching them', async () => {
    const handler = vi.fn();
    const sendResponse = vi.fn();
    const listener = createRuntimeMessageListener(handler);

    expect(listener({ type: 'unknown-command' }, {}, sendResponse)).toBe(true);

    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({
        ok: false,
        command: null,
        error: { code: 'invalid-request' },
      }),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('converts rejected handlers into a typed unexpected error response', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('sensitive failure detail'));
    const sendResponse = vi.fn();
    const listener = createRuntimeMessageListener(handler);

    listener({ type: 'stop-refresh' }, {}, sendResponse);

    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({
        ok: false,
        command: 'stop-refresh',
        error: { code: 'unexpected-error' },
      }),
    );
  });

  it('maps command discriminators to command-specific response payloads', () => {
    type SnapshotCommand = Extract<Command, { type: 'get-snapshot' }>;
    type SnapshotResponse = CommandResponse<SnapshotCommand>;

    expectTypeOf<SnapshotResponse>().toMatchTypeOf<
      | { ok: true; command: 'get-snapshot'; data: AutomationSnapshot }
      | {
          ok: false;
          command: 'get-snapshot';
          error: { code: string };
        }
    >();
  });
});
