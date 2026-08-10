import { DEFAULT_SETTINGS } from '@/core/defaults';
import type { Settings } from '@/core/types';
import {
  createOptionsPageController,
  type OptionsPageElements,
  type OptionsSettingsEditor,
} from '@/entrypoints/options/options-controller';
import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

function createHarness() {
  const { document, window } = parseHTML(`
    <main id="region" aria-busy="true">
      <form id="form">
        <input id="interval" />
        <p id="status" role="status"></p>
        <button id="save" type="submit">Save changes</button>
        <button id="discard" type="button">Discard changes</button>
        <button id="retry" type="button" hidden>Try again</button>
      </form>
    </main>
  `);

  function required<TElement extends Element>(selector: string): TElement {
    const element = document.querySelector(selector);

    if (element === null) {
      throw new Error(`Missing test element: ${selector}.`);
    }

    return element as TElement;
  }

  const elements: OptionsPageElements = {
    form: required('#form'),
    settingsRegion: required('#region'),
    status: required('#status'),
    saveButton: required('#save'),
    discardButton: required('#discard'),
    retryButton: required('#retry'),
  };
  const input = required<HTMLInputElement>('#interval');
  let draft: Settings | null = null;
  const editor: OptionsSettingsEditor = {
    read: vi.fn(() => draft),
    write: vi.fn((settings) => {
      draft = settings;
      input.value = String(settings.rotationIntervalMs);
    }),
    setDisabled: vi.fn((disabled) => {
      input.disabled = disabled;
    }),
  };
  const loadSettings = vi.fn().mockResolvedValue({ ok: true, settings: DEFAULT_SETTINGS });
  const saveSettings = vi.fn().mockImplementation(async (settings: Settings) => ({
    ok: true,
    settings,
  }));
  const controller = createOptionsPageController({
    elements,
    editor,
    loadSettings,
    saveSettings,
    window: window as unknown as Window,
  });

  return {
    controller,
    elements,
    editor,
    input,
    loadSettings,
    saveSettings,
    window,
    setDraft(settings: Settings | null) {
      draft = settings;
      input.value = settings === null ? '' : String(settings.rotationIntervalMs);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    },
  };
}

describe('options page controller', () => {
  it('loads typed settings and renders a clear saved state', async () => {
    const harness = createHarness();

    await harness.controller.start();

    expect(harness.loadSettings).toHaveBeenCalledOnce();
    expect(harness.editor.write).toHaveBeenCalledWith(DEFAULT_SETTINGS);
    expect(harness.elements.settingsRegion.getAttribute('aria-busy')).toBe('false');
    expect(harness.elements.status.textContent).toBe('All changes saved.');
    expect(harness.elements.status.dataset.state).toBe('saved');
    expect(harness.elements.saveButton.disabled).toBe(true);
    expect(harness.elements.discardButton.disabled).toBe(true);
  });

  it('tracks unsaved changes, warns before unload, and discards back to saved settings', async () => {
    const harness = createHarness();
    await harness.controller.start();
    const changedSettings = { ...DEFAULT_SETTINGS, rotationIntervalMs: 60_000 };

    harness.setDraft(changedSettings);

    expect(harness.controller.hasUnsavedChanges()).toBe(true);
    expect(harness.elements.status.textContent).toBe('Unsaved changes.');
    expect(harness.elements.saveButton.disabled).toBe(false);
    expect(harness.elements.discardButton.disabled).toBe(false);

    const beforeUnload = new harness.window.Event('beforeunload', { cancelable: true });
    expect(harness.window.dispatchEvent(beforeUnload)).toBe(false);

    harness.elements.discardButton.click();
    expect(harness.controller.hasUnsavedChanges()).toBe(false);
    expect(harness.editor.write).toHaveBeenLastCalledWith(DEFAULT_SETTINGS);
    expect(harness.elements.status.textContent).toBe('Unsaved changes discarded.');
  });

  it('saves one complete draft, suppresses duplicate submission, and clears dirty state', async () => {
    const harness = createHarness();
    await harness.controller.start();
    const changedSettings = { ...DEFAULT_SETTINGS, includePinned: true };
    let finishSave: ((result: { ok: true; settings: Settings }) => void) | undefined;
    harness.saveSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    harness.setDraft(changedSettings);

    harness.elements.form.dispatchEvent(
      new harness.window.Event('submit', { bubbles: true, cancelable: true }),
    );
    harness.elements.form.dispatchEvent(
      new harness.window.Event('submit', { bubbles: true, cancelable: true }),
    );

    expect(harness.saveSettings).toHaveBeenCalledOnce();
    expect(harness.saveSettings).toHaveBeenCalledWith(changedSettings);
    expect(harness.elements.status.textContent).toBe('Saving changes…');
    expect(harness.elements.settingsRegion.getAttribute('aria-busy')).toBe('true');

    finishSave?.({ ok: true, settings: changedSettings });
    await vi.waitFor(() => expect(harness.elements.status.textContent).toBe('Changes saved.'));
    expect(harness.controller.hasUnsavedChanges()).toBe(false);
    expect(harness.elements.saveButton.disabled).toBe(true);
  });

  it('preserves an unsaved draft after a save failure', async () => {
    const harness = createHarness();
    await harness.controller.start();
    harness.saveSettings.mockResolvedValueOnce({ ok: false, code: 'storage-write-failed' });
    const changedSettings = { ...DEFAULT_SETTINGS, refreshIntervalMs: 60_000 };
    harness.setDraft(changedSettings);

    harness.elements.form.dispatchEvent(
      new harness.window.Event('submit', { bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => expect(harness.elements.status.dataset.state).toBe('error'));
    expect(harness.elements.status.textContent).toContain('edits are still here');
    expect(harness.controller.hasUnsavedChanges()).toBe(true);
    expect(harness.elements.saveButton.disabled).toBe(false);
  });

  it('offers a retry after loading fails and recovers on the next request', async () => {
    const harness = createHarness();
    harness.loadSettings
      .mockResolvedValueOnce({ ok: false, code: 'storage-read-failed' })
      .mockResolvedValueOnce({ ok: true, settings: DEFAULT_SETTINGS });

    await harness.controller.start();

    expect(harness.elements.status.textContent).toContain('could not be loaded');
    expect(harness.elements.retryButton.hidden).toBe(false);
    expect(harness.input.disabled).toBe(true);

    harness.elements.retryButton.click();
    await vi.waitFor(() => expect(harness.loadSettings).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(harness.elements.status.dataset.state).toBe('saved'));
    expect(harness.elements.retryButton.hidden).toBe(true);
    expect(harness.input.disabled).toBe(false);
  });
});
