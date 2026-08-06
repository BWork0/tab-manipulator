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
  type OptionsSettingsEditor,
  type SaveSettingsResult,
} from './options-controller';

function requiredElement<TElement extends HTMLElement>(id: string): TElement {
  const element = document.querySelector<HTMLElement>(`#${id}`);

  if (element === null) {
    throw new Error(`Missing options element: ${id}.`);
  }

  return element as TElement;
}

function formatInterval(intervalMs: number): string {
  if (intervalMs % 60_000 === 0) {
    const minutes = intervalMs / 60_000;
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }

  const seconds = intervalMs / 1_000;
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

function formatRuleCount(rules: readonly string[], emptyLabel: string): string {
  if (rules.length === 0) {
    return emptyLabel;
  }

  return `${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}`;
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

function createSummaryEditor(): OptionsSettingsEditor {
  const rotationInterval = requiredElement('rotation-interval-summary');
  const rotationDirection = requiredElement('rotation-direction-summary');
  const refreshInterval = requiredElement('refresh-interval-summary');
  const pinnedTabs = requiredElement('pinned-tabs-summary');
  const allowlist = requiredElement('allowlist-summary');
  const blocklist = requiredElement('blocklist-summary');
  let currentSettings: Settings | null = null;

  return {
    read: () => currentSettings,
    write(settings) {
      currentSettings = settings;
      rotationInterval.textContent = formatInterval(settings.rotationIntervalMs);
      rotationDirection.textContent =
        settings.rotationDirection === 'forward'
          ? 'Forward (left to right)'
          : settings.rotationDirection === 'backward'
            ? 'Backward (right to left)'
            : 'Random';
      refreshInterval.textContent = formatInterval(settings.refreshIntervalMs);
      pinnedTabs.textContent = settings.includePinned ? 'Included' : 'Excluded';
      allowlist.textContent = formatRuleCount(settings.allowlist, 'All eligible URLs allowed');
      blocklist.textContent = formatRuleCount(settings.blocklist, 'No blocked URLs');
    },
    setDisabled(disabled) {
      requiredElement('settings-summary').setAttribute('aria-disabled', String(disabled));
    },
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
    editor: createSummaryEditor(),
    loadSettings,
    saveSettings,
  });

  void controller.start();
}

main();
