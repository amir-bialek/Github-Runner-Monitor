import '@testing-library/jest-dom'
import { beforeEach } from 'vitest'
import { WIDE_WINDOW, installMatchMedia, setWindowWidth } from './test/matchMedia'

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

// A wide window by default; narrow window tests call setNarrowWindow().
installMatchMedia()
beforeEach(() => {
  setWindowWidth(WIDE_WINDOW)
})
