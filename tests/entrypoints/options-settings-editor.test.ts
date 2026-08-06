import { DEFAULT_SETTINGS } from '@/core/defaults';
import type { Settings } from '@/core/types';
import {
  createOptionsSettingsEditor,
  type OptionsSettingsEditorElements,
} from '@/entrypoints/options/settings-editor';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

function createHarness() {
  const { document } = parseHTML(`
    <fieldset id="fields">
      <select id="rotation-interval">
        <option value="10000">10 seconds</option>
        <option value="30000">30 seconds</option>
        <option value="60000">1 minute</option>
        <option value="custom">Custom</option>
      </select>
      <div id="rotation-custom-group" hidden>
        <input id="rotation-custom" value="10" />
      </div>
      <p id="rotation-validation" hidden></p>
      <select id="direction">
        <option value="forward">Forward</option>
        <option value="backward">Backward</option>
        <option value="random">Random</option>
      </select>
      <p id="direction-validation" hidden></p>
      <select id="refresh-interval">
        <option value="30000">30 seconds</option>
        <option value="60000">1 minute</option>
        <option value="300000">5 minutes</option>
        <option value="custom">Custom</option>
      </select>
      <div id="refresh-custom-group" hidden>
        <input id="refresh-custom" value="300" />
      </div>
      <p id="refresh-validation" hidden></p>
      <input id="include-pinned" type="checkbox" />
    </fieldset>
    <dl id="summary">
      <dd id="allowlist"></dd>
      <dd id="blocklist"></dd>
    </dl>
  `);

  function required<TElement extends Element>(selector: string): TElement {
    const element = document.querySelector(selector);

    if (element === null) {
      throw new Error(`Missing test element: ${selector}.`);
    }

    return element as TElement;
  }

  const elements: OptionsSettingsEditorElements = {
    fields: required('#fields'),
    rotationInterval: required('#rotation-interval'),
    rotationCustomGroup: required('#rotation-custom-group'),
    rotationCustom: required('#rotation-custom'),
    rotationValidation: required('#rotation-validation'),
    rotationDirection: required('#direction'),
    directionValidation: required('#direction-validation'),
    refreshInterval: required('#refresh-interval'),
    refreshCustomGroup: required('#refresh-custom-group'),
    refreshCustom: required('#refresh-custom'),
    refreshValidation: required('#refresh-validation'),
    includePinned: required('#include-pinned'),
    settingsSummary: required('#summary'),
    allowlistSummary: required('#allowlist'),
    blocklistSummary: required('#blocklist'),
  };

  return { editor: createOptionsSettingsEditor(elements), elements };
}

function selectValue(select: HTMLSelectElement, value: string): void {
  for (const option of select.options) {
    option.selected = option.value === value;
  }
}

describe('options settings editor', () => {
  it('renders the documented defaults with pinned tabs excluded', () => {
    const { editor, elements } = createHarness();

    editor.write(DEFAULT_SETTINGS);

    expect(elements.rotationInterval.value).toBe('10000');
    expect(elements.rotationDirection.value).toBe('forward');
    expect(elements.refreshInterval.value).toBe('300000');
    expect(elements.includePinned.checked).toBe(false);
    expect(editor.read()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips custom defaults as one complete settings value', () => {
    const { editor, elements } = createHarness();
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      rotationIntervalMs: 45_000,
      rotationDirection: 'backward',
      refreshIntervalMs: 90_000,
      includePinned: true,
      allowlist: ['example.com'],
      blocklist: ['blocked.example'],
    };

    editor.write(settings);

    expect(elements.rotationInterval.value).toBe('custom');
    expect(elements.rotationCustom.value).toBe('45');
    expect(elements.refreshInterval.value).toBe('custom');
    expect(elements.refreshCustom.value).toBe('90');
    expect(elements.includePinned.checked).toBe(true);
    expect(elements.allowlistSummary.textContent).toBe('1 rule');
    expect(elements.blocklistSummary.textContent).toBe('1 rule');
    expect(editor.read()).toEqual(settings);
  });

  it('rejects invalid intervals without producing a partial update', () => {
    const { editor, elements } = createHarness();
    editor.write(DEFAULT_SETTINGS);
    selectValue(elements.rotationInterval, 'custom');
    elements.rotationCustom.value = '9';
    selectValue(elements.refreshInterval, 'custom');
    elements.refreshCustom.value = '29';

    expect(editor.read()).toBeNull();
    expect(elements.rotationValidation.textContent).toBe('Enter at least 10 seconds.');
    expect(elements.rotationCustom.getAttribute('aria-invalid')).toBe('true');
    expect(elements.refreshValidation.textContent).toBe('Enter at least 30 seconds.');
    expect(elements.refreshCustom.getAttribute('aria-invalid')).toBe('true');
  });
});
