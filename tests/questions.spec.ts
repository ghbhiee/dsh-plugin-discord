import { describe, expect, it } from 'vitest'
import { buildComponents, DISCORD, formatQuestionContent, parseCustomId } from '../src/questions.ts'
import type { QuestionItem } from '../src/questions.ts'

const sample: QuestionItem = {
  id: 'confirm-time',
  header: '确认时间',
  question: '现在是晚上 22:23,「11:40」指哪个?',
  options: [
    { label: '今晚 23:40', description: '约 1 小时后(今晚)' },
    { label: '明天上午 11:40', description: '明天上午' },
  ],
}

describe('formatQuestionContent', () => {
  it('renders header, question, and counter for multi-question asks', () => {
    const content = formatQuestionContent(sample, 1, 3)
    expect(content).toContain('(2/3)')
    expect(content).toContain('**确认时间**')
    expect(content).toContain('11:40')
  })

  it('quotes the detail block and stays under the message limit', () => {
    const content = formatQuestionContent({ ...sample, detail: '第一行\n第二行'.repeat(400) }, 0, 1)
    expect(content).toContain('> 第一行')
    expect(content.length).toBeLessThanOrEqual(1900)
  })

  it('hints at the custom-answer button when there are no options', () => {
    expect(formatQuestionContent({ id: 'q', question: '说说看?' }, 0, 1)).toContain('点击下面的按钮')
  })
})

describe('buildComponents', () => {
  it('builds a single-select plus action buttons', () => {
    const rows = buildComponents('rpc-1', 0, sample) as {
      components: { type: number; custom_id: string; options?: { value: string; label: string }[]; max_values?: number }[]
    }[]
    expect(rows).toHaveLength(2)
    const select = rows[0]?.components[0]
    expect(select?.type).toBe(DISCORD.STRING_SELECT)
    expect(select?.custom_id).toBe('q:rpc-1:0')
    expect(select?.max_values).toBe(1)
    expect(select?.options?.map(option => option.value)).toEqual(['0', '1'])
    const buttons = rows[1]?.components.map(component => component.custom_id)
    expect(buttons).toEqual(['qc:rpc-1:0', 'qx:rpc-1:0'])
  })

  it('widens max_values for multi-select and caps options at 25', () => {
    const many = { ...sample, multiSelect: true, options: Array.from({ length: 30 }, (_, i) => ({ label: `选项${String(i)}` })) }
    const rows = buildComponents('rpc-1', 2, many) as { components: { options?: unknown[]; max_values?: number }[] }[]
    expect(rows[0]?.components[0]?.options).toHaveLength(25)
    expect(rows[0]?.components[0]?.max_values).toBe(25)
  })

  it('emits only buttons when the question has no options', () => {
    const rows = buildComponents('rpc-1', 0, { id: 'q', question: '自由回答' })
    expect(rows).toHaveLength(1)
  })
})

describe('parseCustomId', () => {
  it('round-trips every kind', () => {
    expect(parseCustomId('q:abc:0')).toEqual({ kind: 'select', rpcId: 'abc', index: 0 })
    expect(parseCustomId('qc:abc:3')).toEqual({ kind: 'custom', rpcId: 'abc', index: 3 })
    expect(parseCustomId('qx:abc:1')).toEqual({ kind: 'cancel', rpcId: 'abc', index: 1 })
    expect(parseCustomId('qm:abc:2')).toEqual({ kind: 'modal', rpcId: 'abc', index: 2 })
  })

  it('rejects foreign ids', () => {
    expect(parseCustomId('other:abc:1')).toBeUndefined()
    expect(parseCustomId('q:abc')).toBeUndefined()
    expect(parseCustomId('')).toBeUndefined()
  })
})

