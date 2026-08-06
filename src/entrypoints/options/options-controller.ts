import type { DomainErrorCode, Settings } from '@/core/types';

export interface OptionsRequestFailure {
  ok: false;
  code: DomainErrorCode;
}

export type LoadSettingsResult = { ok: true; settings: Settings } | OptionsRequestFailure;
export type SaveSettingsResult = { ok: true; settings: Settings } | OptionsRequestFailure;

export interface OptionsSettingsEditor {
  read(): Settings | null;
  write(settings: Settings): void;
  setDisabled(disabled: boolean): void;
}

export interface OptionsPageElements {
  form: HTMLFormElement;
  settingsRegion: HTMLElement;
  status: HTMLElement;
  saveButton: HTMLButtonElement;
  discardButton: HTMLButtonElement;
  retryButton: HTMLButtonElement;
}

export interface OptionsPageControllerDependencies {
  elements: OptionsPageElements;
  editor: OptionsSettingsEditor;
  loadSettings(): Promise<LoadSettingsResult>;
  saveSettings(settings: Settings): Promise<SaveSettingsResult>;
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export interface OptionsPageController {
  start(): Promise<void>;
  refreshDraftState(): void;
  hasUnsavedChanges(): boolean;
  destroy(): void;
}

function settingsEqual(left: Settings, right: Settings): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.rotationIntervalMs === right.rotationIntervalMs &&
    left.rotationDirection === right.rotationDirection &&
    left.refreshIntervalMs === right.refreshIntervalMs &&
    left.includePinned === right.includePinned &&
    left.allowlist.length === right.allowlist.length &&
    left.allowlist.every((rule, index) => rule === right.allowlist[index]) &&
    left.blocklist.length === right.blocklist.length &&
    left.blocklist.every((rule, index) => rule === right.blocklist[index])
  );
}

/** Coordinates options loading and saving without directly accessing browser APIs. */
export function createOptionsPageController({
  elements,
  editor,
  loadSettings,
  saveSettings,
  window: windowApi = globalThis.window,
}: OptionsPageControllerDependencies): OptionsPageController {
  let savedSettings: Settings | null = null;
  let draftSettings: Settings | null = null;
  let pending = false;
  let validDraft = true;
  let loadFailed = false;
  let destroyed = false;

  function isDirty(): boolean {
    return (
      savedSettings !== null &&
      draftSettings !== null &&
      !settingsEqual(savedSettings, draftSettings)
    );
  }

  function setStatus(state: 'loading' | 'saved' | 'unsaved' | 'saving' | 'error', text: string) {
    elements.status.dataset.state = state;
    elements.status.textContent = text;
  }

  function renderControls(): void {
    const dirty = isDirty();

    elements.settingsRegion.setAttribute('aria-busy', String(pending));
    elements.saveButton.disabled = pending || !validDraft || !dirty;
    elements.discardButton.disabled = pending || !dirty;
    elements.retryButton.disabled = pending;
    elements.retryButton.hidden = !loadFailed;
    editor.setDisabled(pending || savedSettings === null);
  }

  function refreshDraftState(): void {
    if (pending || savedSettings === null) {
      return;
    }

    draftSettings = editor.read();
    validDraft = draftSettings !== null;
    loadFailed = false;

    if (!validDraft) {
      setStatus('error', 'Some settings need attention before they can be saved.');
    } else if (isDirty()) {
      setStatus('unsaved', 'Unsaved changes.');
    } else {
      setStatus('saved', 'All changes saved.');
    }

    renderControls();
  }

  async function load(): Promise<void> {
    if (pending || destroyed) {
      return;
    }

    pending = true;
    loadFailed = false;
    validDraft = true;
    setStatus('loading', 'Loading saved settings…');
    renderControls();

    const result = await loadSettings();

    if (destroyed) {
      return;
    }

    pending = false;

    if (!result.ok) {
      savedSettings = null;
      draftSettings = null;
      loadFailed = true;
      setStatus('error', 'Saved settings could not be loaded. Try again.');
      renderControls();
      return;
    }

    savedSettings = result.settings;
    draftSettings = result.settings;
    editor.write(result.settings);
    setStatus('saved', 'All changes saved.');
    renderControls();
  }

  async function save(): Promise<void> {
    if (pending || savedSettings === null) {
      return;
    }

    refreshDraftState();

    if (!validDraft || draftSettings === null || !isDirty()) {
      return;
    }

    const settingsToSave = draftSettings;
    pending = true;
    setStatus('saving', 'Saving changes…');
    renderControls();

    const result = await saveSettings(settingsToSave);

    if (destroyed) {
      return;
    }

    pending = false;

    if (!result.ok) {
      setStatus('error', 'Changes could not be saved. Your edits are still here.');
      renderControls();
      return;
    }

    savedSettings = result.settings;
    draftSettings = result.settings;
    validDraft = true;
    editor.write(result.settings);
    setStatus('saved', 'Changes saved.');
    renderControls();
  }

  function discard(): void {
    if (pending || savedSettings === null || !isDirty()) {
      return;
    }

    draftSettings = savedSettings;
    validDraft = true;
    editor.write(savedSettings);
    setStatus('saved', 'Unsaved changes discarded.');
    renderControls();
  }

  function handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void save();
  }

  function handleBeforeUnload(event: BeforeUnloadEvent): void {
    if (!isDirty()) {
      return;
    }

    event.preventDefault();
    event.returnValue = '';
  }

  const handleEditorChange = () => refreshDraftState();
  const handleDiscard = () => discard();
  const handleRetry = () => void load();

  elements.form.addEventListener('submit', handleSubmit);
  elements.form.addEventListener('input', handleEditorChange);
  elements.form.addEventListener('change', handleEditorChange);
  elements.discardButton.addEventListener('click', handleDiscard);
  elements.retryButton.addEventListener('click', handleRetry);
  windowApi?.addEventListener('beforeunload', handleBeforeUnload);
  renderControls();

  return {
    start: load,
    refreshDraftState,
    hasUnsavedChanges: isDirty,
    destroy() {
      destroyed = true;
      elements.form.removeEventListener('submit', handleSubmit);
      elements.form.removeEventListener('input', handleEditorChange);
      elements.form.removeEventListener('change', handleEditorChange);
      elements.discardButton.removeEventListener('click', handleDiscard);
      elements.retryButton.removeEventListener('click', handleRetry);
      windowApi?.removeEventListener('beforeunload', handleBeforeUnload);
    },
  };
}
