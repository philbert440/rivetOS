import { describe, it, expect } from 'vitest'
import { GatewayError } from '@rivetos/gateway-client'
import type { WorkflowField } from '@rivetos/types'
import {
  emptyFormValues,
  gateFieldsAsContract,
  isBooleanishName,
  parseFormValues,
  issuesFromGatewayError,
  isContractError,
} from './form-fields.js'

const CONTRACT: WorkflowField[] = [
  { name: 'message', type: 'string', required: true, description: 'A message' },
  { name: 'count', type: 'number', required: false },
  { name: 'approved', type: 'boolean', required: true },
  { name: 'meta', type: 'json', required: false },
  { name: 'path', type: 'file', required: false },
]

describe('emptyFormValues', () => {
  it('defaults booleans to false and others to empty', () => {
    expect(emptyFormValues(CONTRACT)).toEqual({
      message: '',
      count: '',
      approved: 'false',
      meta: '',
      path: '',
    })
  })
})

describe('gateFieldsAsContract', () => {
  it('marks booleanish names as boolean and requires all', () => {
    const fields = gateFieldsAsContract(['approved', 'comment'])
    expect(fields).toEqual([
      { name: 'approved', type: 'boolean', required: true },
      { name: 'comment', type: 'string', required: true },
    ])
  })
})

describe('isBooleanishName', () => {
  it('recognizes common gate names', () => {
    expect(isBooleanishName('approved')).toBe(true)
    expect(isBooleanishName('is_ready')).toBe(true)
    expect(isBooleanishName('comment')).toBe(false)
  })
})

describe('parseFormValues', () => {
  it('parses typed values and omits empty optionals', () => {
    const r = parseFormValues(CONTRACT, {
      message: 'hi',
      count: '3',
      approved: 'true',
      meta: '{"a":1}',
      path: 'out/x.txt',
    })
    expect(r).toEqual({
      ok: true,
      value: {
        message: 'hi',
        count: 3,
        approved: true,
        meta: { a: 1 },
        path: 'out/x.txt',
      },
    })
  })

  it('flags required empty and bad number/json', () => {
    const r = parseFormValues(CONTRACT, {
      message: '',
      count: 'nope',
      approved: 'false',
      meta: '{',
      path: '',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.message).toBe('required')
    expect(r.issues.count).toBe('must be a number')
    expect(r.issues.meta).toBe('invalid JSON')
  })

  it('treats boolean false as present (not missing)', () => {
    const r = parseFormValues(
      [{ name: 'ok', type: 'boolean', required: true }],
      { ok: 'false' },
    )
    expect(r).toEqual({ ok: true, value: { ok: false } })
  })
})

describe('issuesFromGatewayError', () => {
  it('maps 422 issues by field name', () => {
    const err = new GatewayError(422, 'contract', {
      error: 'validation failed',
      issues: [
        { field: 'message', reason: 'required', message: 'input requires field "message"' },
      ],
    })
    expect(issuesFromGatewayError(err)).toEqual({
      message: 'input requires field "message"',
    })
  })

  it('returns empty for non-422', () => {
    expect(issuesFromGatewayError(new GatewayError(500, 'boom', {}))).toEqual({})
    expect(issuesFromGatewayError(new Error('x'))).toEqual({})
  })
})

describe('isContractError', () => {
  it('detects 422 GatewayError only', () => {
    expect(isContractError(new GatewayError(422, 'x', {}))).toBe(true)
    expect(isContractError(new GatewayError(400, 'x', {}))).toBe(false)
  })
})
