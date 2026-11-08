// A window.matchMedia stub for jsdom, which has none. It answers min-width and
// max-width queries against a pretend window width (wide by default, so the
// side panel shows) and matches nothing else, so prefers-color-scheme stays
// unmatched and the light theme stays the default.

export const WIDE_WINDOW = 1280;
export const NARROW_WINDOW = 600;

let windowWidth = WIDE_WINDOW;

function matches(query: string): boolean {
  const features = query.match(/\([^)]*\)/g) ?? [];
  if (features.length === 0) return false;
  return features.every((feature) => {
    const width = feature.match(/^\(\s*(min|max)-width\s*:\s*([\d.]+)px\s*\)$/);
    if (!width) return false;
    const limit = Number(width[2]);
    return width[1] === 'min' ? windowWidth >= limit : windowWidth <= limit;
  });
}

export function installMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => ({
      // Read on every access, so a rerender after setWindowWidth sees the new width.
      get matches() {
        return matches(query);
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

/** Sets the pretend window width for the next render. */
export function setWindowWidth(width: number): void {
  windowWidth = width;
}

/** A window narrower than the md breakpoint: the top bar and the drawer. */
export function setNarrowWindow(): void {
  setWindowWidth(NARROW_WINDOW);
}
