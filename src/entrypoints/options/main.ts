import type { Settings } from '@/core/types';
import type {
  CommandResponse,
  GetSnapshotCommand,
  UpdateSettingsCommand,
} from '@/messaging/protocol';
import { browser } from 'wxt/browser';
import './style.css';
import {
  createOptionsPageController,
  type LoadSettingsResult,
  type OptionsPageElements,
  type SaveSettingsResult,
} from './options-controller';
import { createOptionsSettingsEditor, type OptionsSettingsEditorElements } from './settings-editor';

function requiredElement<TElement extends HTMLElement>(id: string): TElement {
  const element = document.querySelector<HTMLElement>(`#${id}`);

  if (element === null) {
    throw new Error(`Missing options element: ${id}.`);
  }

  return element as TElement;
}

function getElements(): OptionsPageElements {
  return {
    form: requiredElement<HTMLFormElement>('settings-form'),
    settingsRegion: requiredElement('settings-region'),
    status: requiredElement('save-status'),
    saveButton: requiredElement<HTMLButtonElement>('save-settings-button'),
    discardButton: requiredElement<HTMLButtonElement>('discard-settings-button'),
    retryButton: requiredElement<HTMLButtonElement>('retry-settings-button'),
  };
}

function getSettingsEditorElements(): OptionsSettingsEditorElements {
  return {
    fields: requiredElement<HTMLFieldSetElement>('automation-defaults'),
    rotationInterval: requiredElement<HTMLSelectElement>('default-rotation-interval'),
    rotationCustomGroup: requiredElement('default-rotation-custom-group'),
    rotationCustom: requiredElement<HTMLInputElement>('default-rotation-custom'),
    rotationValidation: requiredElement('default-rotation-validation'),
    rotationDirection: requiredElement<HTMLSelectElement>('default-rotation-direction'),
    directionValidation: requiredElement('default-direction-validation'),
    refreshInterval: requiredElement<HTMLSelectElement>('default-refresh-interval'),
    refreshCustomGroup: requiredElement('default-refresh-custom-group'),
    refreshCustom: requiredElement<HTMLInputElement>('default-refresh-custom'),
    refreshValidation: requiredElement('default-refresh-validation'),
    includePinned: requiredElement<HTMLInputElement>('include-pinned-tabs'),
    settingsSummary: requiredElement('settings-summary'),
    allowlistSummary: requiredElement('allowlist-summary'),
    blocklistSummary: requiredElement('blocklist-summary'),
  };
}

function main(): void {
  async function loadSettings(): Promise<LoadSettingsResult> {
    const command = { type: 'get-snapshot' } satisfies GetSnapshotCommand;

    try {
      const response = (await browser.runtime.sendMessage(command)) as
        CommandResponse<GetSnapshotCommand> | undefined;

      if (response?.command !== command.type) {
        return { ok: false, code: 'unexpected-error' };
      }

      return response.ok
        ? { ok: true, settings: response.data.settings }
        : { ok: false, code: response.error.code };
    } catch {
      return { ok: false, code: 'browser-operation-failed' };
    }
  }

  async function saveSettings(settings: Settings): Promise<SaveSettingsResult> {
    const command = { type: 'update-settings', settings } satisfies UpdateSettingsCommand;

    try {
      const response = (await browser.runtime.sendMessage(command)) as
        CommandResponse<UpdateSettingsCommand> | undefined;

      if (response?.command !== command.type) {
        return { ok: false, code: 'unexpected-error' };
      }

      return response.ok
        ? { ok: true, settings: response.data.settings }
        : { ok: false, code: response.error.code };
    } catch {
      return { ok: false, code: 'browser-operation-failed' };
    }
  }

  const controller = createOptionsPageController({
    elements: getElements(),
    editor: createOptionsSettingsEditor(getSettingsEditorElements()),
    loadSettings,
    saveSettings,
  });

  void controller.start();
}

main();
