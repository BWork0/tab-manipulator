import type { Settings } from '@/core/types';
import {
  evaluateUrlRules,
  parseRuleConfiguration,
  type RuleConfiguration,
  type RuleConfigurationError,
  type RuleDecision,
  type RuleValidationErrorCode,
} from '@/core/rule-engine';
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
  allowlist: HTMLTextAreaElement;
  allowlistValidation: HTMLElement;
  blocklist: HTMLTextAreaElement;
  blocklistValidation: HTMLElement;
  previewUrl: HTMLInputElement;
  previewResult: HTMLElement;
  settingsSummary: HTMLElement;
  allowlistSummary: HTMLElement;
  blocklistSummary: HTMLElement;
}

const ROTATION_PRESETS = new Set([10_000, 30_000, 60_000]);
const REFRESH_PRESETS = new Set([30_000, 60_000, 300_000]);
const RULE_ERROR_MESSAGES: Readonly<Record<RuleValidationErrorCode, string>> = {
  'invalid-domain': 'Enter a plain domain or a wildcard URL pattern.',
  'invalid-url-pattern': 'Use a wildcard URL pattern with scheme://host/path and at least one *.',
  'unsupported-scheme': 'Use http, https, or * as the scheme.',
  'invalid-host-pattern': 'Enter a valid host pattern.',
  'invalid-port': 'Use a port from 1 to 65535, or *.',
};

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

function showRuleValidation(
  control: HTMLElement,
  validation: HTMLElement,
  errors: readonly RuleConfigurationError[],
): void {
  control.setAttribute('aria-invalid', 'true');
  validation.replaceChildren(
    ...errors.map((error) => {
      const item = validation.ownerDocument.createElement('li');
      item.textContent = `Line ${error.line} (${error.value}): ${RULE_ERROR_MESSAGES[error.code]}`;
      return item;
    }),
  );
  validation.hidden = false;
}

function previewMessage(decision: RuleDecision): string {
  switch (decision.reason) {
    case 'empty-allowlist':
      return 'Allowed: the allowlist is empty and no blocklist rule matches.';
    case 'allow-match':
      return `Allowed: matches ${decision.matchedRule}.`;
    case 'block-match':
      return `Blocked: blocklist rule ${decision.matchedRule} wins.`;
    case 'no-allow-match':
      return 'Blocked: no allowlist rule matches.';
    case 'invalid-url':
      return 'Enter a complete HTTP or HTTPS URL.';
  }
}

function renderPreview(
  previewUrl: HTMLInputElement,
  previewResult: HTMLElement,
  configuration: RuleConfiguration | null,
): void {
  const url = previewUrl.value.trim();

  if (configuration === null) {
    previewResult.dataset.state = 'invalid-rules';
    previewResult.textContent = 'Fix every invalid rule before previewing a URL.';
    return;
  }

  if (url === '') {
    previewResult.dataset.state = 'empty';
    previewResult.textContent = 'Enter an HTTP or HTTPS URL to preview the current filters.';
    return;
  }

  const decision = evaluateUrlRules(url, configuration);
  previewResult.dataset.state = decision.allowed ? 'allowed' : 'blocked';
  previewResult.textContent = previewMessage(decision);
}

/** Edits and validates one complete settings value before it can be saved. */
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
    clearValidation(elements.allowlist, elements.allowlistValidation);
    clearValidation(elements.blocklist, elements.blocklistValidation);
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
      const parsedRules = parseRuleConfiguration(
        elements.allowlist.value,
        elements.blocklist.value,
      );
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

      if (!parsedRules.valid) {
        const allowlistErrors = parsedRules.errors.filter((error) => error.list === 'allowlist');
        const blocklistErrors = parsedRules.errors.filter((error) => error.list === 'blocklist');

        if (allowlistErrors.length > 0) {
          showRuleValidation(elements.allowlist, elements.allowlistValidation, allowlistErrors);
        }

        if (blocklistErrors.length > 0) {
          showRuleValidation(elements.blocklist, elements.blocklistValidation, blocklistErrors);
        }

        renderPreview(elements.previewUrl, elements.previewResult, null);
        valid = false;
      } else {
        renderPreview(elements.previewUrl, elements.previewResult, parsedRules.configuration);
      }

      if (
        !valid ||
        rotationIntervalMs === null ||
        refreshIntervalMs === null ||
        !validDirection ||
        !parsedRules.valid
      ) {
        return null;
      }

      return {
        ...currentSettings,
        rotationIntervalMs,
        rotationDirection: direction,
        refreshIntervalMs,
        includePinned: elements.includePinned.checked,
        allowlist: [...parsedRules.configuration.normalizedAllowlist],
        blocklist: [...parsedRules.configuration.normalizedBlocklist],
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
      elements.allowlist.value = settings.allowlist.join('\n');
      elements.blocklist.value = settings.blocklist.join('\n');
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
      const parsedRules = parseRuleConfiguration(settings.allowlist, settings.blocklist);
      renderPreview(
        elements.previewUrl,
        elements.previewResult,
        parsedRules.valid ? parsedRules.configuration : null,
      );
    },
    setDisabled(disabled) {
      elements.fields.disabled = disabled;
      elements.settingsSummary.setAttribute('aria-disabled', String(disabled));
    },
  };
}
