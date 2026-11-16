import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  isThemeId,
  resolveThemeId,
  themeBase,
  themeFrame,
  THEME_ENTRIES
} from '../src/shared/themes'
import type { ResolvedThemeId } from '../src/shared/themes'

/**
 * The theme contract: every palette in the registry has a complete,
 * matching block in styles.css, and its three native-chrome colors equal
 * the block's --bg / --bg-header / --text. A theme that ships a half
 * palette silently mixes foreign tokens into the desk; these tests are
 * what let the CSS stay a plain token list instead of a runtime check.
 */

const stylesPath = join(__dirname, '../src/renderer/src/styles.css')
const css = readFileSync(stylesPath, 'utf8')

const RESOLVED_IDS: ResolvedThemeId[] = [
  'light',
  'dark',
  'gruvbox-dark',
  'gruvbox-light',
  'nord',
  'one-dark',
  'one-light',
  'everforest-dark',
  'everforest-light',
  'dracula',
  'solarized-dark',
  'solarized-light',
  'tokyo-night',
  'catppuccin-mocha'
]

/** The `{ … }` body of the first block whose selector matches exactly. */
function blockBody(selector: string): string {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`missing block: ${selector}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

/** The custom property names a block defines. */
function tokensOf(selector: string): string[] {
  return [...blockBody(selector).matchAll(/(--[a-z-]+)\s*:/g)].map(m => m[1])
}

/** One block's value for a token — searched inside the block only, so a
 *  name shared with the base blocks resolves to this palette's ink. */
function tokenValue(selector: string, token: string): string {
  const m = new RegExp(`--${token.slice(2)}\\s*:\\s*([^;]+);`).exec(
    blockBody(selector)
  )
  return m ? m[1].trim().toLowerCase() : ''
}

function hex6(value: string): boolean {
  return /^#[0-9a-f]{6}$/.test(value)
}

function channel(hex: string, index: number): number {
  const raw = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255
  return raw <= 0.04045 ? raw / 12.92 : Math.pow((raw + 0.055) / 1.055, 2.4)
}

/** WCAG 2.x relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2)
}

/** WCAG contrast ratio between two #rrggbb colors. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Rules at the file's top level only — the ones nested in an at-rule block
 *  are skipped, so a media query can never hide or fake a rule. Comments are
 *  stripped first so a selector is its own text and not the note above it. */
function topLevelRules(): Array<{ selectors: string[]; body: string }> {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Array<{ selectors: string[]; body: string }> = []
  let cursor = 0
  let depth = 0
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const char of flat.slice(cursor, m.index)) {
      if (char === '{') depth++
      else if (char === '}') depth--
    }
    if (depth === 0) {
      rules.push({
        selectors: m[1].split(',').map(s => s.replace(/\s+/g, ' ').trim()),
        body: m[2]
      })
    }
    cursor = m.index + m[0].length
  }
  return rules
}

describe('theme registry', () => {
  it('lists unique ids covering system, both Primer themes and every palette', () => {
    const ids = THEME_ENTRIES.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('system')
    for (const id of RESOLVED_IDS) expect(ids).toContain(id)
  })

  it('keeps the Primer themes and every base honest', () => {
    expect(themeBase('light', true)).toBe('light')
    expect(themeBase('dark', false)).toBe('dark')
    expect(themeBase('system', true)).toBe('dark')
    expect(themeBase('system', false)).toBe('light')
    expect(themeBase('gruvbox-dark', false)).toBe('dark')
    expect(themeBase('solarized-light', true)).toBe('light')
  })

  it('resolves the automatic theme through the OS preference', () => {
    expect(resolveThemeId('system', true)).toBe('dark')
    expect(resolveThemeId('system', false)).toBe('light')
    expect(resolveThemeId('nord', true)).toBe('nord')
  })

  it('rejects unknown ids instead of trusting the settings file', () => {
    expect(isThemeId('gruvbox-dark')).toBe(true)
    expect(isThemeId('system')).toBe(true)
    expect(isThemeId('gruvbox')).toBe(false)
    expect(isThemeId('')).toBe(false)
    expect(isThemeId(null)).toBe(false)
    expect(isThemeId(undefined)).toBe(false)
    expect(isThemeId(42)).toBe(false)
  })

  it('carries well-formed frame colors for every theme', () => {
    for (const id of RESOLVED_IDS) {
      const frame = themeFrame(id, false)
      expect(hex6(frame.ground), `${id} ground`).toBe(true)
      expect(hex6(frame.frame), `${id} frame`).toBe(true)
      expect(hex6(frame.symbols), `${id} symbols`).toBe(true)
    }
  })
})

describe('theme palettes in styles.css', () => {
  const lightSelector = "html[data-theme-base='light']"
  const darkSelector = "html[data-theme-base='dark']"
  const lightBase = tokensOf(lightSelector)
  const darkBase = tokensOf(darkSelector)

  it('defines both base blocks with the full roster', () => {
    expect(lightBase.length).toBeGreaterThan(50)
    expect([...lightBase].sort()).toEqual([...darkBase].sort())
    // The Primer themes are the base blocks, so their registry frame
    // colors are exactly these values (they were shipped as literals
    // long before the registry — the frame still paints from them).
    expect(themeFrame('light', false)).toEqual({
      ground: tokenValue(lightSelector, '--bg'),
      frame: tokenValue(lightSelector, '--bg-header'),
      symbols: tokenValue(lightSelector, '--text')
    })
    expect(themeFrame('dark', false)).toEqual({
      ground: tokenValue(darkSelector, '--bg'),
      frame: tokenValue(darkSelector, '--bg-header'),
      symbols: tokenValue(darkSelector, '--text')
    })
  })

  for (const id of RESOLVED_IDS) {
    if (id === 'light' || id === 'dark') continue
    const selector = `html[data-theme='${id}']`
    const base = themeBase(id, false) === 'light' ? lightBase : darkBase

    it(`gives ${id} a complete block matching its base`, () => {
      const tokens = tokensOf(selector)
      expect([...tokens].sort()).toEqual([...base].sort())
      expect(tokens.length).toBe(new Set(tokens).size)
    })

    it(`keeps ${id}'s native chrome in lockstep with its tokens`, () => {
      const frame = themeFrame(id, false)
      expect(tokenValue(selector, '--bg')).toBe(frame.ground)
      expect(tokenValue(selector, '--bg-header')).toBe(frame.frame)
      expect(tokenValue(selector, '--text')).toBe(frame.symbols)
    })
  }
})

/**
 * The ✨ verb's own contract. Every filled agent button — the tray's Generate,
 * the stash tray's Summarize and Describe, the in-flight Cancel, the batch
 * Resolve — paints its label with --on-accent on --ai-face, so those two
 * tokens are a pair in every palette: a fill its own ink cannot read against is
 * a button whose label has silently gone, and in half the palettes the face and
 * the plain --ai violet were literally the same value. The two guards below are
 * the pair's floor (WCAG AA for normal-size text, at rest and on hover) and the
 * rule that no one may re-ink the verb with a token that can equal its own
 * background.
 */
describe('the agent verb is legible in every palette', () => {
  /** WCAG's floor for normal-size text: a button label is normal-size text. */
  const AA = 4.5
  /** How far the fill must stand off the panel behind it to read as a fill. */
  const MIN_PANEL_SEPARATION = 1.4

  for (const id of RESOLVED_IDS) {
    const selector =
      id === 'light'
        ? "html[data-theme-base='light']"
        : id === 'dark'
          ? "html[data-theme-base='dark']"
          : `html[data-theme='${id}']`

    it(`keeps ${id}'s filled agent verb readable`, () => {
      const ink = tokenValue(selector, '--on-accent')
      const face = tokenValue(selector, '--ai-face')
      const hover = tokenValue(selector, '--ai-face-hover')
      const panel = tokenValue(selector, '--bg-panel')
      for (const value of [ink, face, hover, panel]) expect(hex6(value), id).toBe(true)
      expect(contrast(ink, face), `${id} label at rest`).toBeGreaterThanOrEqual(AA)
      expect(contrast(ink, hover), `${id} label on hover`).toBeGreaterThanOrEqual(AA)
      // Hover darkens, the direction every other face token in the roster moves.
      expect(luminance(hover), `${id} hover darkens the fill`).toBeLessThan(luminance(face))
      expect(contrast(face, panel), `${id} fill reads as a fill`).toBeGreaterThanOrEqual(
        MIN_PANEL_SEPARATION
      )
    })
  }

  it('inks the agent verb with the accent ink, never the decorative violet', () => {
    const allowed = ['--on-accent', '--btn-disabled-ink']
    const verbRules = topLevelRules().filter(r =>
      r.selectors.some(s => s.includes('.btn.ai'))
    )
    expect(verbRules.length).toBeGreaterThan(0)
    let accentInked = 0
    for (const rule of verbRules) {
      for (const ink of [...rule.body.matchAll(/(?:^|;)\s*color:\s*var\((--[a-z-]+)\)/g)]) {
        expect(allowed, `agent verb re-inked with ${ink[1]}: ${rule.selectors.join(', ')}`).toContain(
          ink[1]
        )
        if (ink[1] === '--on-accent') accentInked++
      }
    }
    expect(accentInked).toBeGreaterThan(0)
  })
})
