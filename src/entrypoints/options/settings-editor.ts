import type { Settings } from '@/core/types';
import {
  intervalSecondsToMs,
  isRotationDirection,
  validateRefreshIntervalMs,
  validateRotationIntervalMs,
} from '@/ui/validation';
import type { OptionsSettingsEditor } from './options-controller';

export interface OptionsSettingsEditorElements {
  fields: HTMLFieldSetElement;
  rotationInterval: HTMLSelectElement;
  rotationCustomGroup: HTMLElement;
  rotationCustom: HTMLInputElement;
  rotationValidation: HTMLElement;
  rotationDirection: HTMLSelectElement;
  directionValidation: HTMLElement;
  refreshInterval: HTMLSelectElement;
  refreshCustomGroup: HTMLElement;
  refreshCustom: HTMLInputElement;
  refreshValidation: HTMLElement;
  includePinned: HTMLInputElement;
  settingsSummary: HTMLElement;
  allowlistSummary: HTMLElement;
  blocklistSummary: HTMLElement;
}

const ROTATION_PRESETS = new Set([10_000, 30_000, 60_000]);
const REFRESH_PRESETS = new Set([30_000, 60_000, 300_000]);

function selectOption(select: HTMLSelectElement, value: string): boolean {
  const matched = Array.from(select.options).find((option) => option.value === value);

  for (const option of select.options) {
    option.selected = false;
  }

  if (matched === undefined) {
    return false;
  }

  matched.selected = true;
  return true;
}

function syncInterval(
  select: HTMLSelectElement,
  custom: HTMLInputElement,
  presets: ReadonlySet<number>,
  intervalMs: number,
): void {
  if (presets.has(intervalMs)) {
    selectOption(select, String(intervalMs));
  } else {
    selectOption(select, 'custom');
    custom.value = String(intervalMs / 1_000);
  }
}

function selectedIntervalMs(
  select: HTMLSelectElement,
  custom: HTMLInputElement,
  validate: (value: unknown) => number | null,
): number | null {
  const intervalMs =
    select.value === 'custom' ? intervalSecondsToMs(custom.value) : Number(select.value);
  return validate(intervalMs);
}

function formatRuleCount(rules: readonly string[], emptyLabel: string): string {
  if (rules.length === 0) {
    return emptyLabel;
  }

  return `${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}`;
}

function showValidation(control: HTMLElement, validation: HTMLElement, message: string): void {
  control.setAttribute('aria-invalid', 'true');
  validation.textContent = message;
  validation.hidden = false;
}

function clearValidation(control: HTMLElement, validation: HTMLElement): void {
  control.removeAttribute('aria-invalid');
  validation.textContent = '';
  validation.hidden = true;
}

/** Edits a complete settings value while retaining filter fields owned by T052. */
export function createOptionsSettingsEditor(
  elements: OptionsSettingsEditorElements,
): OptionsSettingsEditor {
  let currentSettings: Settings | null = null;

  function renderCustomGroups(): void {
    elements.rotationCustomGroup.hidden = elements.rotationInterval.value !== 'custom';
    elements.refreshCustomGroup.hidden = elements.refreshInterval.value !== 'custom';
  }

  function clearValidations(): void {
    clearValidation(elements.rotationInterval, elements.rotationValidation);
    clearValidation(elements.rotationCustom, elements.rotationValidation);
    clearValidation(elements.rotationDirection, elements.directionValidation);
    clearValidation(elements.refreshInterval, elements.refreshValidation);
    clearValidation(elements.refreshCustom, elements.refreshValidation);
  }

  elements.rotationInterval.addEventListener('change', renderCustomGroups);
  elements.refreshInterval.addEventListener('change', renderCustomGroups);

  return {
    read() {
      if (currentSettings === null) {
        return null;
      }

      renderCustomGroups();
      clearValidations();
      const rotationIntervalMs = selectedIntervalMs(
        elements.rotationInterval,
        elements.rotationCustom,
        validateRotationIntervalMs,
      );
      const refreshIntervalMs = selectedIntervalMs(
        elements.refreshInterval,
        elements.refreshCustom,
        validateRefreshIntervalMs,
      );
      const direction = elements.rotationDirection.value;
      const validDirection = isRotationDirection(direction);
      let valid = true;

      if (rotationIntervalMs === null) {
        const control =
          elements.rotationInterval.value === 'custom'
            ? elements.rotationCustom
            : elements.rotationInterval;
        showValidation(control, elements.rotationValidation, 'Enter at least 10 seconds.');
        valid = false;
      }

      if (!validDirection) {
        showValidation(
          elements.rotationDirection,
          elements.directionValidation,
          'Choose a valid rotation direction.',
        );
        valid = false;
      }

      if (refreshIntervalMs === null) {
        const control =
          elements.refreshInterval.value === 'custom'
            ? elements.refreshCustom
            : elements.refreshInterval;
        showValidation(control, elements.refreshValidation, 'Enter at least 30 seconds.');
        valid = false;
      }

      if (!valid || rotationIntervalMs === null || refreshIntervalMs === null || !validDirection) {
        return null;
      }

      return {
        ...currentSettings,
        rotationIntervalMs,
        rotationDirection: direction,
        refreshIntervalMs,
        includePinned: elements.includePinned.checked,
      };
    },
    write(settings) {
      currentSettings = settings;
      syncInterval(
        elements.rotationInterval,
        elements.rotationCustom,
        ROTATION_PRESETS,
        settings.rotationIntervalMs,
      );
      selectOption(elements.rotationDirection, settings.rotationDirection);
      syncInterval(
        elements.refreshInterval,
        elements.refreshCustom,
        REFRESH_PRESETS,
        settings.refreshIntervalMs,
      );
      elements.includePinned.checked = settings.includePinned;
      elements.allowlistSummary.textContent = formatRuleCount(
        settings.allowlist,
        'All eligible URLs allowed',
      );
      elements.blocklistSummary.textContent = formatRuleCount(
        settings.blocklist,
        'No blocked URLs',
      );
      clearValidations();
      renderCustomGroups();
    },
    setDisabled(disabled) {
      elements.fields.disabled = disabled;
      elements.settingsSummary.setAttribute('aria-disabled', String(disabled));
    },
  };
}
