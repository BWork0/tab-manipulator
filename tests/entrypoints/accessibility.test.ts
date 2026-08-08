import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

const ENTRYPOINTS = [
  {
    name: 'popup',
    html: fileURLToPath(new URL('../../src/entrypoints/popup/index.html', import.meta.url)),
    css: fileURLToPath(new URL('../../src/entrypoints/popup/style.css', import.meta.url)),
  },
  {
    name: 'options',
    html: fileURLToPath(new URL('../../src/entrypoints/options/index.html', import.meta.url)),
    css: fileURLToPath(new URL('../../src/entrypoints/options/style.css', import.meta.url)),
  },
] as const;

function hasAccessibleName(document: Document, element: Element): boolean {
  const labelledBy = element.getAttribute('aria-labelledby');

  if (labelledBy !== null) {
    return labelledBy
      .split(/\s+/u)
      .every((id) => (document.getElementById(id)?.textContent.trim().length ?? 0) > 0);
  }

  if ((element.getAttribute('aria-label')?.trim().length ?? 0) > 0) {
    return true;
  }

  if (element.localName === 'button') {
    return (element.textContent?.trim().length ?? 0) > 0;
  }

  const id = element.id;
  const explicitLabel = id === '' ? null : document.querySelector(`label[for="${id}"]`);
  const implicitLabel = element.closest('label');
  return (
    (explicitLabel?.textContent.trim().length ?? 0) > 0 ||
    (implicitLabel?.textContent.trim().length ?? 0) > 0
  );
}

describe('entrypoint accessibility contract', () => {
  for (const entrypoint of ENTRYPOINTS) {
    it(`${entrypoint.name} labels every control, group, and description reference`, () => {
      const { document } = parseHTML(readFileSync(entrypoint.html, 'utf8'));
      const controls = document.querySelectorAll(
        'button, input:not([type="hidden"]), select, textarea',
      );

      for (const control of controls) {
        expect(hasAccessibleName(document as unknown as Document, control), control.outerHTML).toBe(
          true,
        );
      }

      for (const fieldset of document.querySelectorAll('fieldset')) {
        expect(
          fieldset.querySelector(':scope > legend')?.textContent.trim().length,
        ).toBeGreaterThan(0);
      }

      for (const group of document.querySelectorAll('[role="group"], [role="region"]')) {
        expect(hasAccessibleName(document as unknown as Document, group), group.outerHTML).toBe(
          true,
        );
      }

      for (const describedElement of document.querySelectorAll('[aria-describedby]')) {
        const descriptionIds = describedElement.getAttribute('aria-describedby')!.split(/\s+/u);

        for (const id of descriptionIds) {
          expect(
            document.getElementById(id),
            `${describedElement.id} references #${id}`,
          ).not.toBeNull();
        }
      }
    });

    it(`${entrypoint.name} provides live feedback, visible focus, dark mode, and narrow zoom layout`, () => {
      const { document } = parseHTML(readFileSync(entrypoint.html, 'utf8'));
      const css = readFileSync(entrypoint.css, 'utf8');

      expect(document.querySelector('[aria-live], [role="status"], [role="alert"]')).not.toBeNull();
      expect(css).toMatch(/button:focus-visible/u);
      expect(css).toMatch(/input:focus-visible/u);
      expect(css).toMatch(/select:focus-visible/u);
      expect(css).toMatch(/@media \(prefers-color-scheme: dark\)/u);
      expect(css).toMatch(/@media \(max-width:/u);
      expect(css).toMatch(/scrollbar-width:\s*thin/u);
      expect(css).toMatch(/::-webkit-scrollbar-thumb/u);
    });
  }

  it('uses an explicit Firefox-safe popup body width', () => {
    const popupCss = readFileSync(ENTRYPOINTS[0].css, 'utf8');

    expect(popupCss).toMatch(/body\s*\{[^}]*width:\s*22rem;/su);
    expect(popupCss).not.toMatch(/max-width:\s*100vw/u);
    expect(popupCss).toMatch(/overflow-x:\s*hidden/u);
  });
});
