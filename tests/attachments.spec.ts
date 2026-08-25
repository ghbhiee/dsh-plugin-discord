import { describe, expect, it } from 'vitest'
import { capabilityNotice, extractFileMarkers, isPathUnder, sanitizeFilename } from '../src/attachments.ts'

describe('extractFileMarkers', () => {
  it('leaves markerless text untouched', () => {
    expect(extractFileMarkers('普通回复')).toEqual({ text: '普通回复', paths: [] })
  })

  it('extracts one marker and strips its line', () => {
    const input = '文档写好了。\n\n[discord-file: /tmp/报告.md]\n\n还有别的说明。'
    const result = extractFileMarkers(input)
    expect(result.paths).toEqual(['/tmp/报告.md'])
    expect(result.text).toBe('文档写好了。\n\n还有别的说明。')
    expect(result.text).not.toContain('discord-file')
  })

  it('extracts several markers in order', () => {
    const input = '[discord-file: /a/x.png]\n[discord-file: /b/y.pdf]\n完毕'
    const result = extractFileMarkers(input)
    expect(result.paths).toEqual(['/a/x.png', '/b/y.pdf'])
    expect(result.text).toBe('完毕')
  })

  it('tolerates surrounding whitespace, keeps inline mentions as text', () => {
    const result = extractFileMarkers('  [discord-file:  /tmp/a.txt ]  \n提到 [discord-file: 但不在行首独立] 的写法不算')
    expect(result.paths).toEqual(['/tmp/a.txt'])
    expect(result.text).toContain('不算')
  })
})

describe('isPathUnder', () => {
  it('accepts the root itself and its children', () => {
    expect(isPathUnder('/a/b', '/a/b')).toBe(true)
    expect(isPathUnder('/a/b/c.txt', '/a/b')).toBe(true)
  })

  it('rejects siblings and prefix look-alikes', () => {
    expect(isPathUnder('/a/bc/file', '/a/b')).toBe(false)
    expect(isPathUnder('/etc/passwd', '/a/b')).toBe(false)
  })
})

describe('sanitizeFilename', () => {
  it('keeps ordinary and Chinese names', () => {
    expect(sanitizeFilename('report-v2.md')).toBe('report-v2.md')
    expect(sanitizeFilename('工作原理.md')).toBe('工作原理.md')
  })

  it('strips directories and odd characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('a b/c:d.txt')).toBe('c_d.txt')
    expect(sanitizeFilename('...')).toBe('file')
  })
})

describe('capabilityNotice', () => {
  it('names the marker and the size cap', () => {
    const notice = capabilityNotice(8_000_000)
    expect(notice).toContain('[discord-file:')
    expect(notice).toContain('8MB')
    expect(notice).toContain('.discord-uploads')
  })

  it('teaches the containment rule, aiming tools at the cwd, and the copy-in fallback', () => {
    const bare = capabilityNotice(8_000_000)
    expect(bare).toContain('仅限会话工作目录')
    expect(bare).toContain('输出目录参数')
    expect(bare).toContain('复制进会话工作目录')
    const withRoots = capabilityNotice(8_000_000, ['/Users/x/Downloads', '/tmp'])
    expect(withRoots).toContain('/Users/x/Downloads')
    expect(withRoots).toContain('/tmp')
  })
})
