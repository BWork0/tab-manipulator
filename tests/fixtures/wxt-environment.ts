const environment = import.meta.env as unknown as Record<string, boolean | number | string>;

function readBoolean(value: boolean | number | string | undefined): boolean {
  return value === true || value === 'true';
}

export const wxtEnvironment = {
  browser: String(environment.BROWSER),
  manifestVersion: Number(environment.MANIFEST_VERSION),
  chrome: readBoolean(environment.CHROME),
  firefox: readBoolean(environment.FIREFOX),
};
