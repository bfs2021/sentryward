import "@testing-library/jest-dom/vitest"
import { afterAll, afterEach, vi } from "vitest"
import { cleanup, configure } from "@testing-library/react"

// Pages are lazy (App.tsx); the first render of a route waits while vitest
// transforms that page's module, which can outlast the 1s default.
configure({ asyncUtilTimeout: 3000 })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  // The selected workspace is remembered there; each test starts fresh.
  localStorage.clear()
})

// sonner removes a dismissed toast from an uncleared 200ms timer. If a toast
// auto-closes just before a file's last test ends, that timer fires after
// jsdom is torn down and React's setState throws "window is not defined",
// failing the run even though every test passed. Outwait it before teardown.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 250)))

// jsdom lacks matchMedia, used by the shadcn sidebar's mobile hook
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
})

// jsdom lacks the pointer capture and scrolling APIs Radix Select calls when it
// opens, and that sonner calls when a toast's button is pressed
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.scrollIntoView ??= () => {}

// jsdom lacks ResizeObserver, which cmdk (SearchableSelect) uses to size its list
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
