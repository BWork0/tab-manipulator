import optionsHtml from '@/entrypoints/options/index.html?raw';
import optionsMainSource from '@/entrypoints/options/main.ts?raw';
import optionsStyles from '@/entrypoints/options/style.css?raw';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

const APPROVED_PERMISSIONS = ['tabs', 'storage', 'alarms'];

function normalizedText(element: Element | null | undefined): string {
  return element?.textContent.replace(/\s+/g, ' ').trim() ?? '';
}

describe('options privacy and permission explanation', () => {
  it('explains local-only handling, network privacy, and schedule cleanup', () => {
    const { document } = parseHTML(optionsHtml);
    const privacyCopy = normalizedText(document.querySelector('.privacy-card'));

    expect(privacyCopy).toContain('Settings are saved in extension-local storage');
    expect(privacyCopy).toContain('Stopping a schedule deletes its runtime tab descriptors');
    expect(privacyCopy).toContain(
      'No browsing metadata, settings, error details, or usage data is sent over the network',
    );
    expect(privacyCopy).toContain('no analytics, remote logging, or remote code');
  });

  it('lists exactly the approved manifest permissions and explains the tabs permission', () => {
    const { document } = parseHTML(optionsHtml);
    const permissionEntries = Array.from(
      document.querySelectorAll<HTMLElement>('#permission-list [data-permission]'),
    );

    expect(permissionEntries.map((entry) => entry.dataset.permission)).toEqual(
      APPROVED_PERMISSIONS,
    );
    expect(normalizedText(permissionEntries[0])).toContain(
      'Reads tab titles, URLs, pinned state, and order',
    );
    expect(normalizedText(permissionEntries[0])).toContain(
      'activates rotation targets and reloads refresh targets',
    );
  });

  it('references only packaged options-page resources and contains no network client', () => {
    const { document } = parseHTML(optionsHtml);
    const resourceUrls = Array.from(document.querySelectorAll<HTMLElement>('[href], [src]')).map(
      (element) => element.getAttribute('href') ?? element.getAttribute('src'),
    );

    expect(resourceUrls).toEqual(['./main.ts']);
    expect(optionsStyles).not.toMatch(/url\(\s*['"]?(?:https?:)?\/\//i);
    expect(optionsMainSource).not.toMatch(
      /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/,
    );
  });
});
